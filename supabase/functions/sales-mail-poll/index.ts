// supabase/functions/sales-mail-poll/index.ts
//
// Reads the sales@coldd.dev mailbox (Migadu) over IMAP every few minutes and
// turns ClearlyDev order emails into rows in public.platform_sales
// (platform 'clearlydev', source 'email'), keyed on the ClearlyDev order
// number, the same key as the imported history, so nothing doubles up.
// Every email read is kept in public.inbound_emails (parsed / ignored / failed)
// so one the parser could not read can be looked at and re-read later.
// New mail is marked read once it has been handled.
//
//   supabase functions deploy sales-mail-poll --no-verify-jwt
//   cron: sales-mail-poll, every 5 minutes, POST {"action":"sync"} with x-cron-secret
//
// Auth: the shared x-cron-secret (CRON_SECRET), or a signed-in admin.
// Secrets: SALES_IMAP_PASSWORD (the mailbox password, set by the owner);
// optional SALES_IMAP_USER (default sales@coldd.dev), SALES_IMAP_HOST
// (default imap.migadu.com).
// Actions: "sync" (default), "ping" (connects and reads the server greeting,
// no login; proves the mailbox host is reachable from here).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import PostalMime from "npm:postal-mime@2";
import { parseClearlyDevOrder } from "../_shared/clearlydev_email.ts";

const MAX_PER_RUN = 25;
// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

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

// ---------- a small IMAP client (only what this job needs) ----------
class Imap {
  private conn!: Deno.TlsConn;
  private buf = new Uint8Array(0);
  private tagN = 0;
  private enc = new TextEncoder();
  private dec = new TextDecoder("latin1");

  async open(host: string) {
    this.conn = await Deno.connectTls({ hostname: host, port: 993 });
    return await this.readLine(); // greeting
  }
  close() { try { this.conn.close(); } catch (_) { /* already closed */ } }

  private async fill() {
    const chunk = new Uint8Array(65536);
    const n = await this.conn.read(chunk);
    if (n === null) throw new Error("IMAP connection closed");
    const next = new Uint8Array(this.buf.length + n);
    next.set(this.buf); next.set(chunk.subarray(0, n), this.buf.length);
    this.buf = next;
  }
  private async readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = this.dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return line;
        }
      }
      await this.fill();
    }
  }
  private async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  // Sends one command; returns the untagged lines and any literals, throws on NO/BAD.
  async cmd(text: string): Promise<{ lines: string[]; literals: Uint8Array[] }> {
    const tag = "C" + (++this.tagN);
    await this.conn.write(this.enc.encode(`${tag} ${text}\r\n`));
    const lines: string[] = [], literals: Uint8Array[] = [];
    for (;;) {
      let line = await this.readLine();
      // A line ending in {N} is followed by N raw bytes, then the rest of the line.
      let m = line.match(/\{(\d+)\}$/);
      while (m) {
        literals.push(await this.readBytes(Number(m[1])));
        const rest = await this.readLine();
        line += " <literal> " + rest;
        m = rest.match(/\{(\d+)\}$/);
      }
      if (line.startsWith(tag + " ")) {
        if (!/^\S+ OK/i.test(line)) throw new Error(line.replace(/LOGIN .*/i, "LOGIN ...").slice(0, 200));
        return { lines, literals };
      }
      lines.push(line);
    }
  }
}
const quote = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';

// USD per one unit of `cur` (ClearlyDev sold in GBP before its 2025 relaunch).
async function usdPerUnit(cur: string, cache: Map<string, number>) {
  if (cur === "USD") return 1;
  if (cache.has(cur)) return cache.get(cur)!;
  const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(cur)}&symbols=USD`);
  const rate = Number((await r.json())?.rates?.USD);
  if (!(rate > 0)) throw new Error(`No ${cur}/USD rate`);
  cache.set(cur, rate);
  return rate;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "sync");

  const cronSecret = Deno.env.get("CRON_SECRET") || "";
  if (!(cronSecret && req.headers.get("x-cron-secret") === cronSecret)) {
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Please sign in." }, 401);
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", u.user.id).single();
    if (!prof?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
  }

  const host = Deno.env.get("SALES_IMAP_HOST") || "imap.migadu.com";
  if (action === "ping") {
    const imap = new Imap();
    try { const greeting = await imap.open(host); return json({ ok: /^\* OK/i.test(greeting), host, greeting: greeting.slice(0, 120) }); }
    catch (e) { return json({ ok: false, host, error: (e as Error).message }); }
    finally { imap.close(); }
  }
  if (action !== "sync") return json({ ok: false, error: "Unknown action." }, 400);

  const { data: prev } = await admin.from("platform_sync_state").select("*").eq("platform", "clearlydev").maybeSingle();
  async function saveState(patch: Obj) {
    await admin.from("platform_sync_state").upsert({ platform: "clearlydev", last_run_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...patch });
  }
  const user = Deno.env.get("SALES_IMAP_USER") || "sales@coldd.dev";
  const pass = Deno.env.get("SALES_IMAP_PASSWORD") || "";
  if (!pass) {
    await saveState({ last_error: "SALES_IMAP_PASSWORD is not set", cookie_ok: null });
    return json({ ok: true, configured: false });
  }

  const imap = new Imap();
  let loginOk: boolean | null = null, error = "";
  const summary = { read: 0, parsed: 0, ignored: 0, failed: 0, written: 0 };
  try {
    await imap.open(host);
    try { await imap.cmd(`LOGIN ${quote(user)} ${quote(pass)}`); loginOk = true; }
    catch (_) { loginOk = false; throw new Error("Mailbox login failed for " + user); }
    await imap.cmd("SELECT INBOX");
    const search = await imap.cmd("UID SEARCH UNSEEN");
    const uids = search.lines.filter((l) => /^\* SEARCH/i.test(l)).flatMap((l) => l.replace(/^\* SEARCH\s*/i, "").split(/\s+/)).filter(Boolean).slice(0, MAX_PER_RUN);

    const byTitle = new Map<string, string>();
    const { data: prods } = await admin.from("products").select("id, title").limit(5000);
    (prods || []).forEach((p: Obj) => { const k = norm(p.title); if (k && !byTitle.has(k)) byTitle.set(k, p.id); });
    const rates = new Map<string, number>();

    for (const uid of uids) {
      const f = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[])`);
      const raw = f.literals[0];
      if (!raw) continue;
      summary.read++;
      const mail = await PostalMime.parse(raw);
      const messageId = mail.messageId || `uid-${uid}-${mail.date || ""}`;
      const sentAt = mail.date ? new Date(mail.date) : new Date();
      const row: Obj = {
        message_id: messageId,
        sent_at: isNaN(sentAt.getTime()) ? null : sentAt.toISOString(),
        mail_from: mail.from?.address || null,
        rcpt_to: (mail.to || []).map((t: Obj) => t.address).filter(Boolean).join(", ") || user,
        subject: (mail.subject || "").slice(0, 500),
        text_body: (mail.text || "").slice(0, 200000),
        html_body: (mail.html || "").slice(0, 400000),
      };
      const parsed = parseClearlyDevOrder({ subject: mail.subject || "", html: mail.html || "", text: mail.text || "" });
      if (parsed.ok) {
        try {
          const perUnit = await usdPerUnit(parsed.currency, rates);
          const names = parsed.items.map((i) => i.name).filter(Boolean);
          const qty = parsed.items.reduce((s, i) => s + (i.qty || 1), 0) || 1;
          // A forwarded order email (e.g. a test forward of an old one) carries the
          // forward's date; the real order date is the one in the subject.
          const forwarded = /^\s*(fwd?|fw)\s*:/i.test(mail.subject || "") || !/clearlydev\.com$/i.test(mail.from?.address || "");
          const up = await admin.from("platform_sales").upsert({
            platform: "clearlydev", source: "email", external_id: parsed.orderId,
            sold_at: (forwarded && parsed.subjectDate) || row.sent_at || new Date().toISOString(),
            product_id: names.length === 1 && qty === 1 ? byTitle.get(norm(names[0])) || null : null,
            product_name: (names.join(", ") || "ClearlyDev order").slice(0, 300),
            currency: parsed.currency, amount: parsed.total, amount_usd: Math.round(parsed.total * perUnit * 10000) / 10000,
            quantity: qty, buyer_name: parsed.buyer, status: "paid",
            raw: { email_message_id: messageId }, updated_at: new Date().toISOString(),
          }, { onConflict: "platform,external_id", ignoreDuplicates: true });
          if (up.error) throw new Error(up.error.message);
          summary.parsed++; summary.written++;
          Object.assign(row, { platform: "clearlydev", external_id: parsed.orderId, status: "parsed", error: null });
        } catch (e) {
          summary.failed++;
          Object.assign(row, { platform: "clearlydev", external_id: parsed.orderId, status: "failed", error: (e as Error).message.slice(0, 300) });
        }
      } else {
        // A ClearlyDev email the parser could not read is a failure worth a look;
        // anything else (forwarding confirmations, newsletters) is just ignored.
        const fromCd = /clearly\s?dev/i.test((mail.from?.address || "") + " " + (mail.subject || "") + " " + (mail.text || "").slice(0, 2000));
        const isOrderish = fromCd && /order|sale|purchase/i.test((mail.subject || "") + " " + (mail.text || "").slice(0, 2000));
        if (isOrderish) summary.failed++; else summary.ignored++;
        Object.assign(row, { platform: fromCd ? "clearlydev" : null, status: isOrderish ? "failed" : "ignored", error: parsed.error });
      }
      await admin.from("inbound_emails").upsert(row, { onConflict: "message_id" });
      await imap.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`);
    }
    await imap.cmd("LOGOUT").catch(() => {});
  } catch (e) {
    error = (e as Error).message;
  } finally {
    imap.close();
  }

  if (loginOk === false && prev?.cookie_ok !== false) {
    const hook = Deno.env.get("ROBLOX_ALERT_WEBHOOK_URL");
    if (hook) await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `:warning: ClearlyDev sale emails: could not log in to ${user}. Check SALES_IMAP_PASSWORD.` }) }).catch(() => {});
  }
  await saveState({
    cookie_ok: loginOk, last_error: error || null, last_written: summary.written,
    ...(error ? {} : { last_ok_at: new Date().toISOString() }),
  });
  return json({ ok: !error, ...summary, error: error || undefined });
});
