// supabase/functions/admin-robux-revenue/index.ts
//
// Deploy with:
//   supabase functions deploy admin-robux-revenue --no-verify-jwt
//
// Group Robux revenue from Roblox's economy API (legacy, cookie-authenticated):
//   GET https://economy.roblox.com/v2/groups/{groupId}/transactions?transactionType=Sale   the sale ledger
//   GET https://economy.roblox.com/v1/groups/{groupId}/revenue/summary/{Day|Week|Month|Year}  Roblox's own totals
// Secrets: ROBLOX_FALLBACK_COOKIE (an alt account in the group that can view group revenue) and
// ROBLOX_GROUP_ID, the same two the Robux order verification already uses.
//
// Stored in robux_sales / robux_state (supabase/robux_revenue.sql). Verified against the real API:
//   - ledger rows: { id (always 0), idHash (unique), created, agent{id}, details{id,name,type}, currency{type,amount},
//     isPending, purchaseToken }; amount is what the group receives AFTER Roblox's 30% cut.
//   - Every row is keyed on idHash and upserted, so a re-read never duplicates or skips a sale.
//   - Totals are computed in SQL (admin_robux_stats), never by adding up rows client-side.
//
// Each run: reads the newest pages until it passes RECENT_DAYS back (that also refreshes the pending
// flag on recent sales), then fetches Roblox's Day/Week/Month/Year summaries. A "full" pass (first run,
// weekly, or force) walks the whole history and resumes from a saved cursor if it runs out of time.
//
// Cadence (cron every minute): a quick run reads the newest ledger page and stops once it is
// all stored (one request when nothing is new); the 45-day re-read (refreshes pending flags)
// runs every 15 minutes, Roblox's summaries + group balance every 5. A run in progress makes
// the next one skip (robux_state.reconcile.running_until), so requests never double up.
//
// Auth: an admin's session, or the shared x-cron-secret. Read-only against Roblox.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyRobloxCookieBroken } from "../_shared/roblox.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const ECON = "https://economy.roblox.com";
const BUDGET_MS = 100000;
const QUICK_BUDGET_MS = 40000;
const RECENT_EVERY_MS = 15 * 60 * 1000;
const SUMMARY_EVERY_MS = 5 * 60 * 1000;
const MIN_GAP_MS = 500;
const RECENT_DAYS = 45;
const FULL_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WAIT_MS = 20000;

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

let DEADLINE = Infinity;
let NEXT_SLOT = 0;
let COOLDOWN_UNTIL = 0;
const overBudget = () => Date.now() > DEADLINE;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ApiFail extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}

async function roblox(cookie: string, path: string): Promise<Obj> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (overBudget()) throw new ApiFail(408, "Ran out of time.");
    const pause = COOLDOWN_UNTIL - Date.now();
    if (pause > 0) {
      if (Date.now() + pause > DEADLINE) throw new ApiFail(408, "Ran out of time.");
      await sleep(pause);
    }
    const slot = Math.max(0, NEXT_SLOT - Date.now());
    NEXT_SLOT = Math.max(Date.now(), NEXT_SLOT) + MIN_GAP_MS;
    if (slot > 0) await sleep(slot);
    let res: Response;
    try {
      res = await fetch(path.startsWith("https://") ? path : ECON + path, { headers: { Cookie: `.ROBLOSECURITY=${cookie}`, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    } catch {
      throw new ApiFail(504, "Roblox did not answer in time.");
    }
    // Roblox tells us how many requests are left in the window: wait for the reset instead of hitting 429.
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(remaining) && remaining <= 1 && Number.isFinite(reset) && reset > 0) {
      COOLDOWN_UNTIL = Math.max(COOLDOWN_UNTIL, Date.now() + Math.min(MAX_WAIT_MS, reset * 1000 + 250));
    }
    if (res.status === 401 || res.status === 403) throw new ApiFail(res.status, "Roblox rejected the cookie.");
    if (res.status === 429) {
      const wait = Math.min(MAX_WAIT_MS, Math.max(Number(res.headers.get("retry-after") || 0) * 1000, Number.isFinite(reset) && reset > 0 ? reset * 1000 : 0, 2000 * 2 ** attempt));
      COOLDOWN_UNTIL = Math.max(COOLDOWN_UNTIL, Date.now() + wait);
      if (attempt === 3) throw new ApiFail(429, "Roblox rate limit hit.");
      continue;
    }
    const text = await res.text();
    let data: Obj = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
    if (!res.ok) throw new ApiFail(res.status, `Roblox returned ${res.status}.`);
    return data;
  }
  throw new ApiFail(500, "Roblox request failed.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "sync");

    const cronSecret = Deno.env.get("CRON_SECRET") || "";
    const isCron = cronSecret.length > 0 && req.headers.get("x-cron-secret") === cronSecret;
    if (!isCron) {
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);
      const { data: profile, error: profileErr } = await admin.from("profiles").select("is_admin").eq("id", userData.user.id).single();
      if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
    }
    if (action !== "sync") return json({ ok: false, error: "Unknown action." }, 400);

    const cookie = Deno.env.get("ROBLOX_FALLBACK_COOKIE");
    const groupId = Deno.env.get("ROBLOX_GROUP_ID");
    if (!cookie || !groupId) return json({ ok: true, configured: false });
    const force = body.force === true;

    const { data: st0 } = await admin.from("robux_state").select("*").eq("id", true).maybeSingle();
    const st: Obj = st0 ?? {};
    const rc: Obj = st.reconcile || {};
    const ageOf = (t: unknown) => (t ? Date.now() - new Date(String(t)).getTime() : Infinity);
    if (!force && rc.running_until && new Date(rc.running_until).getTime() > Date.now()) {
      return json({ ok: true, configured: true, skipped: "another sync is running" });
    }
    const lastFullAge = st.last_full_at ? Date.now() - new Date(st.last_full_at).getTime() : Infinity;
    const full = force || lastFullAge >= FULL_EVERY_MS || !!st.resume_cursor;
    const deep = full || ageOf(rc.recent_at) >= RECENT_EVERY_MS;
    const sumDue = force || deep || ageOf(st.summary?.fetched_at) >= SUMMARY_EVERY_MS;
    DEADLINE = Date.now() + (deep ? BUDGET_MS : QUICK_BUDGET_MS);
    if (st0) await admin.from("robux_state").update({ reconcile: { ...rc, running_until: new Date(DEADLINE + 30000).toISOString() } }).eq("id", true);
    const patch: Obj = {};
    const errors: string[] = [];
    const summary: Obj = {};

    // 1) the sale ledger, newest first
    try {
      let cursor: string | null = full && st.resume_cursor ? String(st.resume_cursor) : null;
      const cutoff = Date.now() - RECENT_DAYS * 86400000;
      let pagesRead = 0, rowsSaved = 0, finished = false, skipped = 0;
      while (!overBudget()) {
        const q = `/v2/groups/${groupId}/transactions?transactionType=Sale&limit=100&sortOrder=Desc` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        let d: Obj;
        try {
          d = await roblox(cookie, q);
        } catch (e) {
          if ((e as ApiFail).status === 408) break; // out of time: keep the cursor, carry on next run
          throw e;
        }
        const rows: Obj[] = Array.isArray(d.data) ? d.data : [];
        pagesRead++;
        const out: Obj[] = [];
        for (const r of rows) {
          // only Robux sales with a usable key and amount (anything else is counted, not guessed at)
          if (!r.idHash || r.currency?.type !== "Robux" || !Number.isFinite(Number(r.currency?.amount)) || !r.created) { skipped++; continue; }
          out.push({
            id_hash: String(r.idHash),
            created_at: new Date(r.created).toISOString(),
            amount: Math.round(Number(r.currency.amount)),
            item_id: r.details?.id != null ? Number(r.details.id) : null,
            item_name: r.details?.name != null ? String(r.details.name).slice(0, 200) : null,
            item_type: r.details?.type != null ? String(r.details.type) : null,
            buyer_id: r.agent?.id != null ? Number(r.agent.id) : null,
            is_pending: !!r.isPending,
            synced_at: new Date().toISOString(),
          });
        }
        // Quick run: a page that is all stored already means nothing newer is missing.
        let allKnown = false;
        if (!deep && out.length) {
          const { data: have } = await admin.from("robux_sales").select("id_hash").in("id_hash", out.map((o) => o.id_hash));
          allKnown = (have || []).length >= out.length;
        }
        if (out.length) {
          const { error } = await admin.from("robux_sales").upsert(out, { onConflict: "id_hash" });
          if (error) throw new Error("save sales: " + error.message);
          rowsSaved += out.length;
        }
        cursor = d.nextPageCursor ? String(d.nextPageCursor) : null;
        if (allKnown) { finished = true; break; }
        if (!cursor) { finished = true; break; }
        const oldest = rows.length ? Date.parse(rows[rows.length - 1].created) : Infinity;
        if (!full && oldest < cutoff) { finished = true; break; }
      }
      patch.last_sync_at = new Date().toISOString();
      if (full) {
        patch.resume_cursor = finished ? null : cursor;
        if (finished) patch.last_full_at = patch.last_sync_at;
      }
      if (deep && !full && finished) patch.reconcile = { ...rc, recent_at: patch.last_sync_at };
      summary.ledger = { mode: full ? "full" : deep ? "recent" : "quick", pages: pagesRead, saved: rowsSaved, skipped, finished };
    } catch (e) {
      const f = e as ApiFail;
      errors.push("ledger: " + f.message);
      if (f.status === 401 || f.status === 403) {
        try { await notifyRobloxCookieBroken(`Group Robux revenue sync got HTTP ${f.status} - the cookie is likely expired.`); } catch { /* alert is best effort */ }
      }
    }

    // 2) Roblox's own totals, kept for reconciliation (every 5 minutes)
    if (sumDue) try {
      const sums: Obj = {};
      for (const tf of ["Day", "Week", "Month", "Year"]) {
        if (overBudget()) break;
        const d = await roblox(cookie, `/v1/groups/${groupId}/revenue/summary/${tf}`);
        // Every figure Roblox returns is kept (payouts and other money going out sit
        // next to the sales figures), not just the two the dashboard shows.
        const all: Obj = {};
        for (const [k, v] of Object.entries(d)) if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))) all[k] = Number(v);
        sums[tf] = { itemSaleRobux: Number(d.itemSaleRobux) || 0, pendingRobux: Number(d.pendingRobux) || 0, all };
      }
      // The group's Robux balance right now, for the "minimum balance before DevEx"
      // figure. Needs the account to see group funds; when it can't, the admin just
      // leaves the balance out.
      let balance: Obj = { ok: false };
      if (!overBudget()) {
        try {
          const b = await roblox(cookie, `/v1/groups/${groupId}/currency`);
          if (typeof b.robux === "number") balance = { ok: true, robux: b.robux, fetched_at: new Date().toISOString() };
        } catch (e) { balance = { ok: false, status: (e as ApiFail).status || 0 }; }
      }
      if (Object.keys(sums).length) patch.summary = { fetched_at: new Date().toISOString(), ...sums, balance };
      // Daily spending for the Robux panel's graph (Roblox only gives rolling totals):
      // in the first hour after midnight Sydney, the "past day" figures are the day
      // that just ended. Missed that hour (sync down)? The day is left out, not guessed.
      if (sums.Day?.all) {
        const sydDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
        const sydHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
        const today = sydDate(new Date());
        if (sydHour < 1 && rc.snap_day !== today) {
          let robuxIn = 0, robuxOut = 0;
          for (const [k, v] of Object.entries(sums.Day.all as Obj)) {
            if (k === "pendingRobux") continue;
            const n = Number(v) || 0;
            if (n > 0) robuxIn += n; else robuxOut -= n;
          }
          const day = sydDate(new Date(Date.now() - 2 * 3600000));
          const { error } = await admin.from("robux_daily").upsert({ day, robux_out: Math.round(robuxOut), robux_in: Math.round(robuxIn), captured_at: new Date().toISOString() }, { onConflict: "day" });
          if (!error) patch.reconcile = { ...(patch.reconcile || rc), snap_day: today };
        }
      }
    } catch (e) { if ((e as ApiFail).status !== 408) errors.push("summary: " + (e as Error).message); }
    // Money going out shows in the summary (groupPayoutRobux is negative). The group
    // sale ledger has no spending types: Purchase, GroupPayout, AdSpend and DevEx all
    // answer 400 for a group (checked 2026-11-24).

    // 3) Spending history from the group audit log ("Spend Group Funds": one-time payouts
    //    and other spending, each with its amount and date) into robux_spend_log, for the
    //    spending graph and the minimum balance. Needs the sync account to have the group's
    //    "View audit log" permission; until then Roblox answers 403 and this retries hourly.
    //    The first read walks back through the whole log (resuming across runs); after that
    //    it reads the newest page every 15 minutes and stops at entries already stored.
    const auditFull = !rc.audit_full_at;
    const auditDue = auditFull && rc.audit_cursor ? true : ageOf(rc.audit_checked_at) >= (rc.audit_ok ? 15 * 60 * 1000 : 60 * 60 * 1000);
    if (auditDue && !overBudget()) {
      let cursor: string = auditFull && rc.audit_cursor ? String(rc.audit_cursor) : "", pages = 0, saved = 0, done = false;
      const audit: Obj = { audit_checked_at: new Date().toISOString() };
      try {
        while (!overBudget() && pages < (auditFull ? 25 : 2)) {
          const d = await roblox(cookie, `https://groups.roblox.com/v1/groups/${groupId}/audit-log?actionType=SpendGroupFunds&limit=100&sortOrder=Desc` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
          pages++;
          const out: Obj[] = [];
          for (const r of (Array.isArray(d.data) ? d.data : []) as Obj[]) {
            const desc: Obj = r.description && typeof r.description === "object" ? r.description : {};
            const amount = Math.abs(Number(desc.Amount ?? desc.amount));
            const cur = String(desc.CurrencyTypeName ?? desc.CurrencyType ?? "Robux");
            if (!r.created || !Number.isFinite(amount) || amount <= 0 || /tix|ticket/i.test(cur)) continue;
            const key = `${r.created}|${amount}|${JSON.stringify(desc)}|${r.actor?.user?.userId ?? ""}`;
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key)))).map((b) => b.toString(16).padStart(2, "0")).join("");
            out.push({ id: hash, created_at: new Date(r.created).toISOString(), robux: Math.round(amount),
              item: String(desc.ItemDescription ?? desc.itemDescription ?? "").slice(0, 300) || null,
              actor_role: r.actor?.role?.name ?? null, description: desc, synced_at: new Date().toISOString() });
          }
          let allKnown = false;
          if (out.length) {
            if (!auditFull) {
              const { data: have } = await admin.from("robux_spend_log").select("id").in("id", out.map((o) => o.id));
              allKnown = (have || []).length >= out.length;
            }
            const { error } = await admin.from("robux_spend_log").upsert(out, { onConflict: "id" });
            if (error) throw new Error("save spending: " + error.message);
            saved += out.length;
          }
          cursor = d.nextPageCursor ? String(d.nextPageCursor) : "";
          if (!cursor || allKnown) { done = true; break; }
        }
        Object.assign(audit, { audit_ok: true, audit_status: null, audit_saved: saved,
          audit_cursor: auditFull && !done ? cursor : null, ...(auditFull && done ? { audit_full_at: new Date().toISOString() } : {}) });
      } catch (e) {
        const st = (e as ApiFail).status || 0;
        if (st === 408) delete audit.audit_checked_at;
        else Object.assign(audit, { audit_ok: false, audit_status: st, ...(auditFull ? { audit_cursor: cursor || null } : {}) });
      }
      patch.reconcile = { ...(patch.reconcile || rc), ...audit };
    }

    patch.reconcile = { ...(patch.reconcile || rc), running_until: null };
    patch.last_error = errors.length ? errors.join("; ").slice(0, 400) : null;
    patch.updated_at = new Date().toISOString();
    await admin.from("robux_state").upsert({ id: true, ...patch }, { onConflict: "id" });
    if (errors.length) console.warn("[admin-robux-revenue] partial:", errors);
    return json({ ok: true, configured: true, summary, errors });
  } catch (err) {
    console.error("[admin-robux-revenue] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
