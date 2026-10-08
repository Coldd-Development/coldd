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
// Auth: an admin's session, or the shared x-cron-secret. Read-only against Roblox.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyRobloxCookieBroken } from "../_shared/roblox.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const ECON = "https://economy.roblox.com";
const BUDGET_MS = 100000;
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
      res = await fetch(ECON + path, { headers: { Cookie: `.ROBLOSECURITY=${cookie}`, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
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
    DEADLINE = Date.now() + BUDGET_MS;
    const force = body.force === true;

    const { data: st0 } = await admin.from("robux_state").select("*").eq("id", true).maybeSingle();
    const st: Obj = st0 ?? {};
    const lastFullAge = st.last_full_at ? Date.now() - new Date(st.last_full_at).getTime() : Infinity;
    const full = force || lastFullAge >= FULL_EVERY_MS || !!st.resume_cursor;
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
        if (out.length) {
          const { error } = await admin.from("robux_sales").upsert(out, { onConflict: "id_hash" });
          if (error) throw new Error("save sales: " + error.message);
          rowsSaved += out.length;
        }
        cursor = d.nextPageCursor ? String(d.nextPageCursor) : null;
        if (!cursor) { finished = true; break; }
        const oldest = rows.length ? Date.parse(rows[rows.length - 1].created) : Infinity;
        if (!full && oldest < cutoff) { finished = true; break; }
      }
      patch.last_sync_at = new Date().toISOString();
      if (full) {
        patch.resume_cursor = finished ? null : cursor;
        if (finished) patch.last_full_at = patch.last_sync_at;
      }
      summary.ledger = { mode: full ? "full" : "recent", pages: pagesRead, saved: rowsSaved, skipped, finished };
    } catch (e) {
      const f = e as ApiFail;
      errors.push("ledger: " + f.message);
      if (f.status === 401 || f.status === 403) {
        try { await notifyRobloxCookieBroken(`Group Robux revenue sync got HTTP ${f.status} - the cookie is likely expired.`); } catch { /* alert is best effort */ }
      }
    }

    // 2) Roblox's own totals, kept for reconciliation
    try {
      const sums: Obj = {};
      for (const tf of ["Day", "Week", "Month", "Year"]) {
        if (overBudget()) break;
        const d = await roblox(cookie, `/v1/groups/${groupId}/revenue/summary/${tf}`);
        sums[tf] = { itemSaleRobux: Number(d.itemSaleRobux) || 0, pendingRobux: Number(d.pendingRobux) || 0 };
      }
      if (Object.keys(sums).length) patch.summary = { fetched_at: new Date().toISOString(), ...sums };
    } catch (e) { if ((e as ApiFail).status !== 408) errors.push("summary: " + (e as Error).message); }

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
