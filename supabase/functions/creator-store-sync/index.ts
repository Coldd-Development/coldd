// supabase/functions/creator-store-sync/index.ts
//
// Background Creator Store sync: reads the seller-payments ledger every few
// minutes and writes each sale to public.platform_sales (platform
// 'creatorstore'), so Creator Store counts on the admin dashboard without the
// transactions page being open. The Tampermonkey userscript still syncs too
// when the page is open; both use the same payment id, so a sale is one row.
//
//   supabase functions deploy creator-store-sync --no-verify-jwt
//   cron: creator-store-sync, every 5 minutes, POST {"action":"sync"} with x-cron-secret
//
// Auth: the shared x-cron-secret (CRON_SECRET), or a signed-in admin.
// Secret: ROBLOX_CREATOR_COOKIE = the .ROBLOSECURITY of the account that owns
// the Creator Store items. It is used for exactly one read-only request (the
// sales list below), never logged, never returned. Signing that session out
// on Roblox kills it immediately; the admin then shows "cookie expired".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyRobloxCookieBroken } from "../_shared/roblox.ts";

const API = "https://apis.roblox.com/marketplace-fiat-service/v1/seller/payments";
const DIVISOR = 1_000_000_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 400;          // first run walks the whole history; later runs stop early
const OVERLAP_MS = 3 * 86400000; // re-read the last 3 days each run (late or changed payments)
const BUDGET_MS = 120000;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Same id rule as the userscript, so the two never make duplicate rows.
function toRow(p: Obj) {
  const base = p.basePayment || {};
  const when = new Date(base.paymentDateTime || 0);
  if (isNaN(when.getTime())) return null;
  const assetId = String(base.assetId || base.productId || "");
  const gross = (Number(base.totalAmount?.quantity?.significand) || 0) / DIVISOR;
  const net = (Number(p.netAmount?.quantity?.significand) || 0) / DIVISOR;
  const currency = String(base.totalAmount?.currencyCode || base.totalAmount?.currency || "USD").toUpperCase();
  return {
    external_id: String(base.paymentId || `${base.paymentDateTime}|${p.purchaserId || p.purchaserName}|${assetId}`).slice(0, 200),
    sold_at: when.toISOString(),
    product_name: String(base.productName || "Unknown asset").slice(0, 300),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    amount: Math.round(gross * 10000) / 10000,
    net_amount: Math.round(net * 10000) / 10000,
    buyer_name: p.purchaserName ? String(p.purchaserName).slice(0, 200) : null,
    buyer_ref: p.purchaserId ? String(p.purchaserId) : null,
    raw: { assetId, assetType: base.assetType || null },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  if (String(body.action || "sync") !== "sync") return json({ ok: false, error: "Unknown action." }, 400);

  const cronSecret = Deno.env.get("CRON_SECRET") || "";
  if (!(cronSecret && req.headers.get("x-cron-secret") === cronSecret)) {
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Please sign in." }, 401);
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", u.user.id).single();
    if (!prof?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
  }

  const cookie = (Deno.env.get("ROBLOX_CREATOR_COOKIE") || "").trim();
  const { data: prev } = await admin.from("platform_sync_state").select("*").eq("platform", "creatorstore").maybeSingle();
  async function saveState(patch: Obj) {
    await admin.from("platform_sync_state").upsert({ platform: "creatorstore", last_run_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...patch });
  }
  if (!cookie) {
    await saveState({ last_error: "ROBLOX_CREATOR_COOKIE is not set", cookie_ok: null });
    return json({ ok: true, configured: false });
  }

  // Incremental: stop once a whole page is older than (newest stored sale - 3 days).
  const { data: newestRow } = await admin.from("platform_sales").select("sold_at").eq("platform", "creatorstore").order("sold_at", { ascending: false }).limit(1).maybeSingle();
  const cutoff = newestRow?.sold_at ? new Date(newestRow.sold_at).getTime() - OVERLAP_MS : 0;
  const deadline = Date.now() + BUDGET_MS;

  const rows: Obj[] = [];
  // Quick run (cron every minute): one page, stopping when it is all stored; the 3-day
  // re-read (late or changed payments) runs every 15 minutes.
  const deep = body.force === true || new Date().getUTCMinutes() % 15 === 0 || !newestRow;
  let cursor = "", pages = 0, error = "", cookieOk: boolean | null = true;
  try {
    while (pages < MAX_PAGES && Date.now() < deadline) {
      const url = `${API}?pageInfo.cursor=${encodeURIComponent(cursor)}&pageInfo.pageSize=${PAGE_SIZE}&pageInfo.previous=false&purchasePriceFilter=PURCHASE_PRICE_FILTER_ALL`;
      const res = await fetch(url, { headers: { Cookie: `.ROBLOSECURITY=${cookie}`, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (res.status === 401 || res.status === 403) { cookieOk = false; throw new Error(`Roblox rejected the cookie (${res.status})`); }
      if (res.status === 429) { await sleep(3000); continue; }
      if (!res.ok) throw new Error(`Roblox returned ${res.status}`);
      const data = await res.json();
      pages++;
      const list: Obj[] = Array.isArray(data.sellerPayments) ? data.sellerPayments : [];
      let anyNew = false;
      for (const p of list) {
        const r = toRow(p);
        if (!r) continue;
        if (new Date(r.sold_at).getTime() >= cutoff) anyNew = true;
        rows.push(r);
      }
      if (!data.pageInfo?.hasMore || !data.pageInfo?.nextCursor) break;
      if (cutoff && !anyNew) break;
      if (!deep) {
        const ids = list.map(toRow).filter(Boolean).map((r) => (r as Obj).external_id);
        const { data: have } = await admin.from("platform_sales").select("external_id").eq("platform", "creatorstore").in("external_id", ids);
        if ((have || []).length >= ids.length) break;
      }
      cursor = data.pageInfo.nextCursor;
      await sleep(250);
    }
  } catch (e) {
    error = (e as Error).message;
  }

  // Product match by title, then upsert (re-sending the same sale updates it).
  let written = 0;
  if (rows.length) {
    const byTitle = new Map<string, string>();
    const { data: prods } = await admin.from("products").select("id, title").limit(5000);
    (prods || []).forEach((p: Obj) => { const k = norm(p.title); if (k && !byTitle.has(k)) byTitle.set(k, p.id); });
    const seen = new Set<string>();
    const payload = rows.filter((r) => !seen.has(r.external_id) && seen.add(r.external_id)).map((r) => ({
      platform: "creatorstore", source: "api", status: "paid", quantity: 1,
      product_id: byTitle.get(norm(r.product_name)) || null,
      // Creator Store sells in USD; anything else is stored as-is and counted at face value.
      amount_usd: r.amount, net_usd: r.net_amount,
      updated_at: new Date().toISOString(), ...r,
    }));
    for (let i = 0; i < payload.length; i += 500) {
      const up = await admin.from("platform_sales").upsert(payload.slice(i, i + 500), { onConflict: "platform,external_id" });
      if (up.error) { error = error || "Could not save: " + up.error.message; break; }
      written += Math.min(500, payload.length - i);
    }
  }

  if (cookieOk === false && prev?.cookie_ok !== false) {
    await notifyRobloxCookieBroken("the Creator Store sync cookie (ROBLOX_CREATOR_COOKIE) was rejected. Sign in to Roblox in an incognito window and paste the new cookie into Supabase secrets.");
  }
  const newest = rows.reduce((m, r) => (r.sold_at > m ? r.sold_at : m), prev?.newest_sale_at || "");
  await saveState({
    cookie_ok: cookieOk,
    last_error: error || null,
    last_written: written,
    ...(error ? {} : { last_ok_at: new Date().toISOString() }),
    ...(newest ? { newest_sale_at: newest } : {}),
  });
  return json({ ok: !error, pages, read: rows.length, written, error: error || undefined });
});
