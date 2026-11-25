// supabase/functions/mailbox-poll/index.ts
//
// Reads the coldd.dev mailboxes (Migadu, IMAP) every 10 minutes:
//   * Receipts: a vendor's receipt or invoice email in billing@, frchrono@, management@, noreply@
//     or sales@ (never the customer-facing mailboxes) is stored in the private
//     finance-receipts bucket (its PDF attachments, or the email itself when it has none) and
//     attached to the matching bank expense in finance_expenses (same vendor, bank date a few
//     days after the email, amount when it shows one). With no expense yet (the bank statement
//     is imported later) it waits in finance_receipt_inbox and is matched on later runs.
//   * Tasks: every new email to support@, legal@ and marketing@ becomes a task in admin_todos
//     ("Support email" / "Legal email" / "Marketing email"), from the day this went live.
// Mail is only peeked at: never marked read, moved or deleted.
//
//   supabase functions deploy mailbox-poll --no-verify-jwt
//   cron: mailbox-poll, every 10 minutes (cloned from creator-store-sync's job)
//
// Auth: the shared x-cron-secret (CRON_SECRET), or a signed-in admin.
// Secrets: MAILBOX_<NAME> = the password of <name>@coldd.dev, saved with
// scripts/set-mailbox-secrets.cjs; optional MAILBOX_HOST (default imap.migadu.com).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import PostalMime from "npm:postal-mime@2";
import { Imap, imapQuote, searchUids } from "../_shared/imap.ts";
import { htmlToText } from "../_shared/clearlydev_email.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

const ACCOUNTS = ["support", "legal", "marketing", "billing", "frchrono", "management", "noreply", "sales"];
const TASK_LABELS: Record<string, string> = { support: "Support email", legal: "Legal email", marketing: "Marketing email" };
// Receipts are only looked for in the business mailboxes, never in customer-facing ones.
const RECEIPT_ACCOUNTS = new Set(["billing", "frchrono", "management", "noreply", "sales"]);
const RECEIPTS_SINCE = "1-Jul-2026";
const MAX_PER_ACCOUNT = 40;
const RUN_BUDGET_MS = 110000;
const BUCKET = "finance-receipts";
const TZ = "Australia/Hobart";

// Senders worth opening for receipts (IMAP FROM is a substring match).
const VENDOR_FROM = ["anthropic", "openai", "notion", "migadu", "discord", "stripe.com", "x.com", "roblox", "builtbybit", "tebex",
  "rotechads", "sellhub", "payhip", "paypal", "accotax", "xero"];
// Vendor = the "Paid to" the bank import gave that company. First match wins, so the
// specific ones come first. `subject` limits a vendor to its receipt emails only.
const VENDORS: { re: RegExp; vendor: string; subject?: RegExp }[] = [
  { re: /x developer platform|developer\.x\.com|devs@x\.com/i, vendor: "X Developer Platform" },
  { re: /receipt from x\b|paidfeatures@x\.com|x premium/i, vendor: "X Corp" },
  { re: /builtbybit/i, vendor: "Tebex", subject: /receipt for your account upgrade at builtbybit/i },
  { re: /anthropic|claude (pro|max)/i, vendor: "Anthropic" },
  { re: /openai|chatgpt/i, vendor: "OpenAI" },
  { re: /notion/i, vendor: "Notion" },
  { re: /migadu/i, vendor: "Migadu" },
  { re: /roblox/i, vendor: "Roblox" },
  { re: /ticket ?tool|discord/i, vendor: "Discord" },
  { re: /rotechads|adblox/i, vendor: "RoTechAds" },
  { re: /sellhub/i, vendor: "Sellhub" },
  { re: /payhip|omnitech/i, vendor: "Payhip" },
  { re: /accotax/i, vendor: "Accotax Advisory" },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "https://coldd.dev",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
      "Content-Type": "application/json",
    },
  });
}
const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const localDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const addDays = (day: string, n: number) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayGap = (a: string, b: string) => Math.round((Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 86400000);
function orFrom(list: string[]): string {
  return list.length === 1 ? `FROM ${imapQuote(list[0])}` : `OR FROM ${imapQuote(list[0])} (${orFrom(list.slice(1))})`;
}
function moneyValues(s: string): number[] {
  const out: number[] = [];
  for (const m of s.matchAll(/(?:A\$|AU\$|US\$|\$|AUD|USD)\s?(\d{1,6}(?:,\d{3})*\.\d{2})/gi)) out.push(Number(m[1].replace(/,/g, "")));
  return [...new Set(out)].slice(0, 20);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json().catch(() => ({}));

  const cronSecret = Deno.env.get("CRON_SECRET") || "";
  if (!(cronSecret && req.headers.get("x-cron-secret") === cronSecret)) {
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Please sign in." }, 401);
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", u.user.id).single();
    if (!prof?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
  }
  if ((body.action || "sync") !== "sync") return json({ ok: false, error: "Unknown action." }, 400);

  const started = Date.now();
  const host = Deno.env.get("MAILBOX_HOST") || "imap.migadu.com";
  const summary: Obj = { accounts: {}, matched: 0 };

  // Vendors paid through PayPal are named after the payee ("Ploxseven"), so a PayPal receipt
  // is matched by finding one of those names in it.
  const { data: ppRows } = await admin.from("finance_expenses").select("vendor").eq("payment_method", "PayPal").not("vendor", "is", null).limit(2000);
  const paypalVendors = [...new Set(((ppRows || []) as Obj[]).map((r) => String(r.vendor)))].filter((v) => norm(v).length >= 4);

  function vendorFor(mail: Obj, text: string): string | null {
    const hay = `${mail.from?.address || ""} ${mail.from?.name || ""} ${mail.subject || ""} ${text.slice(0, 3000)}`;
    if (/paypal/i.test(mail.from?.address || "")) {
      const n = norm(`${mail.subject || ""} ${text.slice(0, 4000)}`);
      return paypalVendors.find((v) => n.includes(norm(v))) || null;
    }
    for (const v of VENDORS) {
      if (!v.re.test(hay)) continue;
      if (v.subject && !v.subject.test(mail.subject || "")) return null;
      return v.vendor;
    }
    return null;
  }
  function isReceipt(mail: Obj, text: string, docs: number): boolean {
    const subj = String(mail.subject || "");
    if (/unauthori[sz]ed|password|sign[- ]?in|verify|verification|security alert|newsletter|what's new|introducing|webinar/i.test(subj)) return false;
    if (/set to automatically renew|will be charged|renews on|upcoming (payment|renewal)|trial (ends|will end)/i.test(text) && !/amount paid|paid on|receipt #|total paid/i.test(text)) return false;
    const kw = /receipt|invoice|payment|paid|order|purchase|renewal|subscription|charged|billing/i.test(subj);
    const money = moneyValues(subj + " " + text.slice(0, 6000)).length > 0;
    return docs > 0 ? kw || money : kw && money;
  }

  // The expense this receipt belongs to: same vendor, bank date 2 days before to 6 days
  // after the email, the amount when the email shows it, nearest date. One that already
  // has a receipt is only taken when nothing else fits (and then reported, not doubled).
  async function findExpense(vendor: string, day: string, amounts: number[], src: string) {
    const { data } = await admin.from("finance_expenses").select("id, spent_on, amount, receipts")
      .eq("vendor", vendor).gte("spent_on", addDays(day, -2)).lte("spent_on", addDays(day, 9)).limit(50);
    const list = ((data || []) as Obj[]).filter((e) => !(e.receipts || []).some((r: Obj) => r.src === src));
    if (!list.length) return null;
    const score = (e: Obj) => (amounts.some((a) => Math.abs(a - Number(e.amount)) < 0.005) ? -1000 : 0) + ((e.receipts || []).length ? 500 : 0) + Math.abs(dayGap(e.spent_on, day));
    list.sort((a, b) => score(a) - score(b));
    return { expense: list[0], already: (list[0].receipts || []).length > 0 };
  }
  async function attach(expenseId: string, files: Obj[]) {
    const { data: e } = await admin.from("finance_expenses").select("receipts").eq("id", expenseId).single();
    const have: Obj[] = Array.isArray(e?.receipts) ? e!.receipts : [];
    const add = files.filter((f) => !have.some((h) => h.path === f.path));
    if (add.length) await admin.from("finance_expenses").update({ receipts: have.concat(add) }).eq("id", expenseId);
  }

  async function handleReceipt(account: string, mail: Obj, raw: Uint8Array, messageId: string) {
    const { data: seen } = await admin.from("finance_receipt_inbox").select("id").eq("message_id", messageId).maybeSingle();
    if (seen) return;
    const text = (mail.text || htmlToText(mail.html || "")).slice(0, 20000);
    const atts = ((mail.attachments || []) as Obj[]).filter((a) =>
      /pdf/i.test(a.mimeType || "") || /\.pdf$/i.test(a.filename || "") ||
      (/^image\//i.test(a.mimeType || "") && a.disposition === "attachment" && !a.related && (a.content?.byteLength || 0) > 20000));
    const vendor = vendorFor(mail, text);
    const sentAt = mail.date ? new Date(mail.date) : new Date();
    const base: Obj = { message_id: messageId, account, sent_at: isNaN(sentAt.getTime()) ? null : sentAt.toISOString(),
      mail_from: mail.from?.address || null, subject: String(mail.subject || "").slice(0, 300), vendor };
    if (!vendor || !isReceipt(mail, text, atts.length)) {
      await admin.from("finance_receipt_inbox").upsert({ ...base, status: "ignored" }, { onConflict: "message_id" });
      return;
    }
    const day = localDay(isNaN(sentAt.getTime()) ? new Date() : sentAt), src = "email:" + messageId;
    const amounts = moneyValues(String(mail.subject || "") + " " + text);
    const hit = await findExpense(vendor, day, amounts, src);
    // Its expense already has a receipt (added by hand): note it, store nothing.
    if (hit && hit.already) {
      await admin.from("finance_receipt_inbox").upsert({ ...base, amounts, status: "already", expense_id: hit.expense.id }, { onConflict: "message_id" });
      return;
    }
    // Store the documents: the PDFs (and attached photos), or the email itself.
    const files: Obj[] = [];
    try {
      const docs = atts.length ? atts.map((a) => ({ name: a.filename || "receipt.pdf", type: /pdf/i.test(a.mimeType || "") || /\.pdf$/i.test(a.filename || "") ? "application/pdf" : a.mimeType, bytes: new Uint8Array(a.content) }))
        : [{ name: String(mail.subject || "Receipt").slice(0, 100) + " (email).html", type: "text/html",
            bytes: new TextEncoder().encode('<!doctype html><meta charset="utf-8"><div style="font:13px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#333;background:#fff;padding:12px 18px;border-bottom:1px solid #ddd">' +
              "<b>Subject</b> " + esc(mail.subject || "") + "<br><b>From</b> " + esc((mail.from?.name ? mail.from.name + " " : "") + "<" + (mail.from?.address || "") + ">") +
              "<br><b>Date</b> " + esc(sentAt.toISOString().replace("T", " ").slice(0, 19)) + " UTC</div>" +
              (mail.html || "<pre style=\"white-space:pre-wrap;font:13px/1.5 monospace;padding:16px\">" + esc(text) + "</pre>")) }];
      for (const d of docs) {
        const ext = d.type === "application/pdf" ? "pdf" : d.type === "text/html" ? "html" : (d.type.split("/")[1] || "bin").replace("jpeg", "jpg");
        const path = day.slice(0, 7) + "/" + crypto.randomUUID() + "." + ext;
        const up = await admin.storage.from(BUCKET).upload(path, d.bytes, { contentType: d.type === "text/html" ? "text/plain" : d.type, upsert: false });
        if (up.error) throw new Error("upload: " + up.error.message);
        files.push({ path, name: d.name, type: d.type, size: d.bytes.byteLength, src });
      }
    } catch (e) {
      await admin.from("finance_receipt_inbox").upsert({ ...base, status: "failed", error: (e as Error).message.slice(0, 300) }, { onConflict: "message_id" });
      return;
    }
    let status = "waiting", expenseId: string | null = null;
    if (hit) { await attach(hit.expense.id, files); status = "attached"; expenseId = hit.expense.id; summary.matched++; }
    await admin.from("finance_receipt_inbox").upsert({ ...base, amounts, status, expense_id: expenseId, files, updated_at: new Date().toISOString() }, { onConflict: "message_id" });
  }

  async function handleTask(account: string, mail: Obj, messageId: string) {
    const label = TASK_LABELS[account];
    const from = String(mail.from?.address || "").toLowerCase();
    if (!label || from === `${account}@coldd.dev`) return;
    const { error } = await admin.from("admin_todos").insert({
      title: (String(mail.subject || "").trim() || "(no subject)").slice(0, 300),
      kind: "email", label, mail_from: from || null, mail_account: account, message_id: messageId, created_by_name: label,
    });
    if (error && error.code !== "23505") throw new Error("task: " + error.message);
  }

  const { data: states } = await admin.from("mailbox_poll_state").select("*");
  const stateOf: Record<string, Obj> = {};
  ((states || []) as Obj[]).forEach((s) => { stateOf[s.account] = s; });

  for (const account of ACCOUNTS) {
    const pass = Deno.env.get("MAILBOX_" + account.toUpperCase());
    if (!pass) continue;
    if (Date.now() - started > RUN_BUDGET_MS) break;
    const st = stateOf[account] || {};
    const user = `${account}@coldd.dev`, out: Obj = { read: 0, tasks: 0 };
    summary.accounts[account] = out;
    const patch: Obj = { account, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const imap = new Imap();
    try {
      await imap.open(host);
      try { await imap.cmd(`LOGIN ${imapQuote(user)} ${imapQuote(pass)}`); patch.login_ok = true; }
      catch (_) { patch.login_ok = false; throw new Error("Mailbox login failed for " + user); }
      const sel = await imap.cmd("EXAMINE INBOX");
      const selText = sel.lines.join("\n");
      const validity = Number((selText.match(/UIDVALIDITY (\d+)/i) || [])[1] || 0);
      const uidNext = Number((selText.match(/UIDNEXT (\d+)/i) || [])[1] || 0);
      const fresh = !st.last_uid || Number(st.uidvalidity) !== validity;
      // First run: new-mail tracking starts now (no tasks for old mail); receipts are read
      // back to 1 July 2026 in batches.
      let lastUid = fresh ? Math.max(0, uidNext - 1) : Number(st.last_uid);
      let backfillUid = fresh ? 0 : Number(st.backfill_uid || 0), backfillDone = fresh ? false : !!st.backfill_done;
      patch.uidvalidity = validity;

      const fetchOne = async (uid: number, headersOnly: boolean) => {
        const f = await imap.cmd(`UID FETCH ${uid} (${headersOnly ? "BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)]" : "BODY.PEEK[]"})`);
        const raw = f.literals[0];
        if (!raw) return null;
        const mail = await PostalMime.parse(raw);
        return { raw, mail: mail as Obj, messageId: (mail as Obj).messageId || `${account}-uid-${validity}-${uid}` };
      };

      // 1) New mail since the last run.
      if (!fresh) {
        const s = await imap.cmd(`UID SEARCH UID ${lastUid + 1}:*`);
        const uids = searchUids(s.lines).filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, MAX_PER_ACCOUNT);
        for (const uid of uids) {
          if (Date.now() - started > RUN_BUDGET_MS) break;
          const head = await fetchOne(uid, true);
          if (head) {
            const fromAddr = String(head.mail.from?.address || "") + " " + String(head.mail.from?.name || "");
            const vendorish = VENDOR_FROM.some((v) => fromAddr.toLowerCase().includes(v));
            if (TASK_LABELS[account]) { await handleTask(account, head.mail, head.messageId); out.tasks++; }
            if (vendorish && RECEIPT_ACCOUNTS.has(account)) {
              const full = await fetchOne(uid, false);
              if (full) await handleReceipt(account, full.mail, full.raw, full.messageId);
            }
            out.read++;
          }
          lastUid = uid;
        }
      }
      // 2) Receipts from 1 July 2026 (once per mailbox, a batch per run).
      if (!RECEIPT_ACCOUNTS.has(account)) backfillDone = true;
      if (!backfillDone && lastUid > 0) {
        const s = await imap.cmd(`UID SEARCH UID ${backfillUid + 1}:${lastUid} SINCE ${RECEIPTS_SINCE} ${orFrom(VENDOR_FROM)}`);
        const uids = searchUids(s.lines).filter((u) => u > backfillUid && u <= lastUid).sort((a, b) => a - b);
        const batch = uids.slice(0, MAX_PER_ACCOUNT);
        for (const uid of batch) {
          if (Date.now() - started > RUN_BUDGET_MS) break;
          const full = await fetchOne(uid, false);
          if (full) { await handleReceipt(account, full.mail, full.raw, full.messageId); out.read++; }
          backfillUid = uid;
        }
        if (!uids.length || (batch.length === uids.length && backfillUid >= batch[batch.length - 1])) backfillDone = true;
      }
      Object.assign(patch, { last_uid: lastUid, backfill_uid: backfillUid, backfill_done: backfillDone, last_error: null, last_ok_at: new Date().toISOString() });
      await imap.cmd("LOGOUT").catch(() => {});
    } catch (e) {
      patch.last_error = (e as Error).message.slice(0, 300);
      out.error = patch.last_error;
    } finally {
      imap.close();
    }
    await admin.from("mailbox_poll_state").upsert(patch, { onConflict: "account" });
  }

  // Receipts waiting for their bank charge: try again (60 days).
  const { data: waiting } = await admin.from("finance_receipt_inbox").select("*").eq("status", "waiting")
    .gte("sent_at", new Date(Date.now() - 60 * 86400000).toISOString()).limit(100);
  for (const w of (waiting || []) as Obj[]) {
    const day = localDay(new Date(w.sent_at || Date.now()));
    const hit = await findExpense(w.vendor, day, (w.amounts || []).map(Number), "email:" + w.message_id);
    if (!hit) continue;
    if (hit.already) { await admin.from("finance_receipt_inbox").update({ status: "already", expense_id: hit.expense.id, updated_at: new Date().toISOString() }).eq("id", w.id); continue; }
    await attach(hit.expense.id, w.files || []);
    await admin.from("finance_receipt_inbox").update({ status: "attached", expense_id: hit.expense.id, updated_at: new Date().toISOString() }).eq("id", w.id);
    summary.matched++;
  }

  const configured = ACCOUNTS.filter((a) => Deno.env.get("MAILBOX_" + a.toUpperCase()));
  return json({ ok: true, configured, ...summary });
});
