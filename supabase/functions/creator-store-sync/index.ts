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
//
// Reviews (the comments under each asset on the Creator Store) every 15 minutes through
// Roblox's public asset-reviews API, without the cookie: one count request per asset we have
// sold, and the comments are read only for an asset whose count went up (all of them once a
// day for edits and replies). Saved through _shared/platform_reviews.ts.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyRobloxCookieBroken } from "../_shared/roblox.ts";
import { flushSaleAlerts } from "../_shared/sale_alerts.ts";
import { buildMatcher, savePlatformReviews, sweepUnmatched, type PlatformReview } from "../_shared/platform_reviews.ts";

const API = "https://apis.roblox.com/marketplace-fiat-service/v1/seller/payments";
const DIVISOR = 1_000_000_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 400;          // first run walks the whole history; later runs stop early
const OVERLAP_MS = 3 * 86400000; // re-read the last 3 days each run (late or changed payments)
const BUDGET_MS = 120000;
const REVIEWS_API = "https://apis.roblox.com/asset-reviews-api/v1/assets/";
const REVIEWS_EVERY_MS = 15 * 60 * 1000;
const REVIEW_GAP_MS = 400;

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
// A tag before the name ("[COMPLETE] Catch a Fish") is not part of the product's name.
const norm = (s: string) => String(s || "").replace(/^\s*(?:\[[^\]]*\]\s*)+/, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// The first all-digit value of several possible field paths.
function firstId(...vals: unknown[]) {
  for (const v of vals) { const s = String(v ?? ""); if (/^\d+$/.test(s)) return s; }
  return "";
}

// Same id rule as the userscript, so the two never make duplicate rows. Roblox puts the asset
// under basePayment.productKey.productTargetId and the buyer under purchaser.entity.longValue
// (the userscript's paths); the older field names are kept as fallbacks.
function toRow(p: Obj) {
  const base = p.basePayment || {};
  const when = new Date(base.paymentDateTime || 0);
  if (isNaN(when.getTime())) return null;
  const assetId = firstId(base.productKey?.productTargetId, base.productKey?.targetId, base.assetId, base.productId);
  const buyerId = firstId(p.purchaser?.entity?.longValue, p.purchaser?.entity?.id, p.purchaserId, p.purchaser?.id);
  const gross = (Number(base.totalAmount?.quantity?.significand) || 0) / DIVISOR;
  const net = (Number(p.netAmount?.quantity?.significand) || 0) / DIVISOR;
  const currency = String(base.totalAmount?.currencyCode || base.totalAmount?.currency || "USD").toUpperCase();
  return {
    external_id: String(base.paymentId || `${base.paymentDateTime}|${p.purchaserId || p.purchaserName}|${base.assetId || base.productId || ""}`).slice(0, 200),
    sold_at: when.toISOString(),
    product_name: String(base.productName || "Unknown asset").slice(0, 300),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "USD",
    amount: Math.round(gross * 10000) / 10000,
    net_amount: Math.round(net * 10000) / 10000,
    buyer_name: p.purchaserName ? String(p.purchaserName).slice(0, 200) : null,
    buyer_ref: buyerId || null,
    raw: { assetId, assetType: base.assetType || null },
  };
}

async function robloxJson(url: string): Promise<Obj | number | null> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (res.status === 429) return 429;
  if (!res.ok) return null;
  return await res.json().catch(() => null);
}

async function syncCreatorReviews(admin: Obj, firstRun: boolean, deep: boolean, deadline: number) {
  const { data: sales } = await admin.from("platform_sales").select("raw, product_name, amount_usd, sold_at")
    .eq("platform", "creatorstore").order("sold_at", { ascending: false }).limit(20000);
  const assets = new Map<string, { name: string; price: number }>();
  for (const r of (sales ?? []) as Obj[]) {
    const id = String(r.raw?.assetId || "");
    if (/^\d+$/.test(id) && !assets.has(id)) assets.set(id, { name: String(r.product_name || ""), price: Number(r.amount_usd) || 0 });
  }
  const { data: stored } = await admin.from("reviews").select("listing_ref").eq("source", "Creator Store").limit(20000);
  const have = new Map<string, number>();
  for (const r of (stored ?? []) as Obj[]) have.set(String(r.listing_ref), (have.get(String(r.listing_ref)) ?? 0) + 1);
  const list: PlatformReview[] = [];
  let checked = 0, read = 0, limited = false;
  for (const [assetId, a] of assets) {
    if (Date.now() > deadline - 10000) break;
    const n = await robloxJson(REVIEWS_API + assetId + "/comments/count");
    await sleep(REVIEW_GAP_MS);
    if (n === 429) { limited = true; break; }
    checked++;
    const count = Number(n);
    if (!Number.isFinite(count) || count <= 0 || (!deep && count <= (have.get(assetId) ?? 0))) continue;
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const d = await robloxJson(REVIEWS_API + assetId + "/comments?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
      await sleep(REVIEW_GAP_MS);
      if (d === 429) { limited = true; break; }
      if (!d || typeof d !== "object") break;
      read++;
      for (const c of (Array.isArray(d.commentResponses) ? d.commentResponses : []) as Obj[]) {
        const when = new Date(Number(c.createdUtc) || 0);
        if (!c.id || isNaN(when.getTime()) || when.getTime() <= 0) continue;
        const replyAt = c.reply?.createdUtc ? new Date(Number(c.reply.createdUtc)) : null;
        list.push({
          external_id: "cs:" + c.id, source: "Creator Store", listing_name: a.name, listing_ref: assetId, price_usd: a.price || null,
          stars: null, recommended: typeof c.isRecommended === "boolean" ? c.isRecommended : null,
          text: String(c.text ?? "").trim(), user_name: c.commentingUsername ? String(c.commentingUsername) : null,
          avatar_url: c.commentingUserId ? "uid:" + c.commentingUserId : null,
          reply: c.reply?.text ? String(c.reply.text).trim() : null,
          reply_at: replyAt && !isNaN(replyAt.getTime()) ? replyAt.toISOString() : null,
          created_at: when.toISOString(),
        });
      }
      if (!d.hasMore || !d.nextCursor) break;
      cursor = String(d.nextCursor);
    }
    if (limited) break;
  }
  // Reviewer headshots (public thumbnails API, 100 users a request).
  const uids = [...new Set(list.map((r) => String(r.avatar_url || "").replace(/^uid:/, "")).filter((u) => /^\d+$/.test(u)))];
  const shot = new Map<string, string>();
  for (let i = 0; i < uids.length && !limited; i += 100) {
    const d = await robloxJson("https://thumbnails.roblox.com/v1/users/avatar-headshot?size=150x150&format=Png&isCircular=false&userIds=" + uids.slice(i, i + 100).join(","));
    await sleep(REVIEW_GAP_MS);
    if (d && typeof d === "object") for (const t of (Array.isArray(d.data) ? d.data : []) as Obj[]) if (t.state === "Completed" && t.imageUrl) shot.set(String(t.targetId), String(t.imageUrl));
  }
  for (const r of list) r.avatar_url = shot.get(String(r.avatar_url || "").replace(/^uid:/, "")) ?? null;
  const matcher = await buildMatcher(admin);
  const saved = await savePlatformReviews(admin, list, { markSeen: firstRun, matcher });
  const swept = await sweepUnmatched(admin, matcher);
  return { assets: assets.size, checked, pages: read, limited, ...saved, swept };
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
  let cutoff = newestRow?.sold_at ? new Date(newestRow.sold_at).getTime() - OVERLAP_MS : 0;
  // Sales saved before the asset id was read correctly: the whole history is read again (once
  // the first page proves the ids come through) so every purchased asset is known.
  const { count: blankAssets } = await admin.from("platform_sales").select("id", { count: "exact", head: true })
    .eq("platform", "creatorstore").eq("raw->>assetId", "");
  let refill = false;
  const deadline = Date.now() + BUDGET_MS;

  const rows: Obj[] = [];
  // Quick run (cron every minute): one page, stopping when it is all stored; the 3-day
  // re-read (late or changed payments) runs every 15 minutes.
  let deep = body.force === true || new Date().getUTCMinutes() % 15 === 0 || !newestRow;
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
      if (pages === 1 && (blankAssets ?? 0) > 0 && rows.some((r) => r.raw?.assetId)) { refill = true; cutoff = 0; deep = true; anyNew = true; }
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
  // Listings uploaded by mistake (platform_sale_ignores) are never written.
  const { data: ign } = await admin.from("platform_sale_ignores").select("product_name").eq("platform", "creatorstore");
  const ignored = new Set(((ign || []) as Obj[]).map((r) => String(r.product_name).toLowerCase()));
  if (ignored.size) for (let i = rows.length - 1; i >= 0; i--) if (ignored.has(String(rows[i].product_name || "").toLowerCase())) rows.splice(i, 1);
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

  // After a full re-read, a sale still without an asset id is not in Roblox's history any more:
  // it is marked 'unknown' so it never starts another full re-read.
  if (refill && !error) {
    const { data: left } = await admin.from("platform_sales").select("id, raw").eq("platform", "creatorstore").eq("raw->>assetId", "").limit(500);
    for (const r of (left ?? []) as Obj[]) await admin.from("platform_sales").update({ raw: { ...(r.raw ?? {}), assetId: "unknown" } }).eq("id", r.id);
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
  // New sales just saved: send their phone alerts now (the database trigger and the
  // sale-alerts cron job are the backups).
  await flushSaleAlerts(admin).catch(() => null);

  let reviews: Obj | undefined;
  const { data: rs } = await admin.from("platform_sync_state").select("last_run_at, last_ok_at").eq("platform", "creatorstore-reviews").maybeSingle();
  const reviewsAge = rs?.last_run_at ? Date.now() - new Date(rs.last_run_at).getTime() : Infinity;
  if (body.force === true || body.reviews === true || reviewsAge >= REVIEWS_EVERY_MS) {
    const now = new Date();
    try {
      // The timer row must save first, or every minute would read the reviews again.
      const { error: timerErr } = await admin.from("platform_sync_state").upsert({ platform: "creatorstore-reviews", last_run_at: now.toISOString(), updated_at: now.toISOString() });
      if (timerErr) throw new Error("review timer: " + timerErr.message);
      reviews = await syncCreatorReviews(admin, !rs?.last_ok_at, body.force === true || !rs?.last_ok_at || (now.getUTCHours() === 3 && now.getUTCMinutes() < 15), deadline + 30000);
      await admin.from("platform_sync_state").upsert({
        platform: "creatorstore-reviews", last_run_at: now.toISOString(), updated_at: new Date().toISOString(),
        last_written: (reviews.added ?? 0) + (reviews.updated ?? 0), last_error: reviews.limited ? "Roblox rate limit; carried on next run" : null,
        ...(reviews.limited ? {} : { last_ok_at: new Date().toISOString() }),
      });
    } catch (e) {
      await admin.from("platform_sync_state").upsert({ platform: "creatorstore-reviews", last_run_at: now.toISOString(), updated_at: new Date().toISOString(), last_error: (e as Error).message.slice(0, 500) });
    }
  }
  return json({ ok: !error, pages, read: rows.length, written, refill, blankAssets, withAsset: rows.filter((r) => r.raw?.assetId).length, reviews, error: error || undefined });
});
