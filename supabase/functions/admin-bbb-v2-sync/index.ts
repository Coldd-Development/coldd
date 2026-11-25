// supabase/functions/admin-bbb-v2-sync/index.ts
//
// Deploy with:
//   supabase functions deploy admin-bbb-v2-sync --no-verify-jwt
//
// Pulls BuiltByBit stats through the v2 API (https://api.builtbybit.com/v2) into
// bbb2_purchases, bbb2_resources, bbb2_funnel and bbb2_state (see supabase/bbb_v2.sql).
// The admin Marketplaces / Dashboard / Analytics panels read those tables directly.
//
//   - purchases: GET /v2/resources/creator/purchases is ACCOUNT-WIDE (one request per 100
//     purchases). Revenue is FinalPrice (what the buyer paid), fee is PlatformFee,
//     ad_fee / ad_fee_credit are AdFeePayment / AdFeeCredit (featured-ad fee on that sale).
//   - resources: GET /v2/resources/creator/resources?with=Description,Category (price,
//     description, category, cover + carousel image urls) for the price / listing checks.
//     Without the with hints the API leaves Description and Category out.
//   - reviews: GET /v2/resources/creator/reviews?with=Reviewer,Resource (account-wide, every
//     10 minutes) into public.reviews through _shared/platform_reviews.ts.
//   - funnel: GET /v2/analytics/single (page views, impressions, cart adds, wishlist adds,
//     purchases, revenue) overall and for each BuiltByBit listing that matches a coldd product.
//
// Auth: an admin's session, or the shared x-cron-secret (the pg_cron job runs `sync` every
// minute). Read-only against BuiltByBit: nothing here writes to BuiltByBit.
// Runs never overlap: each takes a lock (bbb2_state.running_until) and a run that finds
// it taken skips. Quick runs stop after 40 s, the daily full read after 100 s.
// A run with nothing new costs ONE request (page 1 of purchases); listings refresh every
// 6 hours and the funnel every 30 minutes, whatever the cron cadence.
// Secret: BUILTBYBIT_API_TOKEN (the same Private token as v1).
//
// Requests are spaced (MIN_GAP_MS) and a 429 puts every request on a shared cooldown.
// BuiltByBit's rules (api-v2 docs): honour the Retry-After header on a 429 (its value is in
// milliseconds); use the API, never scraping; never share the private token. So a cooldown
// is never cut short: if it does not fit in this run, the run ends, and the cooldown is
// saved in bbb2_state.cooldown_until so the next run waits it out too.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { flushSaleAlerts } from "../_shared/sale_alerts.ts";
import { buildMatcher, savePlatformReviews, sweepUnmatched, type PlatformReview } from "../_shared/platform_reviews.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const V2 = "https://api.builtbybit.com";
const PER_PAGE = 100;
// One request a second at most: BuiltByBit answered 2 a second (the funnel analytics) with a
// 27 s Retry-After on 2026-11-24.
const MIN_GAP_MS = 1000;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 20000;
const QUICK_BUDGET_MS = 40000;
const FULL_BUDGET_MS = 100000;

const PURCHASES_FULL_EVERY_MS = 24 * 60 * 60 * 1000;
const RESOURCES_EVERY_MS = 6 * 60 * 60 * 1000;
const FUNNEL_EVERY_MS = 30 * 60 * 1000;
const REVIEWS_EVERY_MS = 10 * 60 * 1000;

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

let DEADLINE = Infinity;
let COOLDOWN_UNTIL = 0;
let NEXT_SLOT = 0;
const overBudget = () => Date.now() > DEADLINE;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const num = (v: unknown, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const iso = (ts: unknown) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
};
// BBCode / HTML to plain text for comparisons and the listing checks.
function plain(s: unknown): string {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/\[(?:\/)?[a-z*]+(?:=[^\]]*)?\]/gi, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

async function v2(token: string, path: string): Promise<Obj> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (overBudget()) throw new ApiFail(408, "Ran out of time.");
    const pause = COOLDOWN_UNTIL - Date.now();
    if (pause > 0) {
      if (Date.now() + pause > DEADLINE) throw new ApiFail(408, "Ran out of time.");
      await sleep(pause);
    }
    const slot = Math.max(0, NEXT_SLOT - Date.now());
    NEXT_SLOT = Math.max(Date.now(), NEXT_SLOT) + MIN_GAP_MS;
    if (slot > 0) {
      if (Date.now() + slot > DEADLINE) throw new ApiFail(408, "Ran out of time.");
      await sleep(slot);
    }
    let res: Response;
    try {
      res = await fetch(V2 + path, {
        headers: { Authorization: `Private ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiFail(504, "BuiltByBit did not answer in time.");
    }
    if (res.status === 429) {
      // BuiltByBit sends Retry-After in milliseconds. A small number (under 60) is read as
      // seconds instead, and an HTTP date as a date, so the wait is never shorter than asked.
      const ra = (res.headers.get("Retry-After") ?? "").trim();
      const n = Number(ra);
      let hinted = 0;
      if (ra && Number.isFinite(n) && n > 0) hinted = n < 60 ? n * 1000 : n;
      else if (ra && Number.isFinite(Date.parse(ra))) hinted = Date.parse(ra) - Date.now();
      const wait = Math.max(hinted, 1000 * 2 ** attempt);
      COOLDOWN_UNTIL = Math.max(COOLDOWN_UNTIL, Date.now() + wait);
      console.warn("[admin-bbb-v2-sync] 429 on", path.split("?")[0], "cooling down", wait, "ms");
      if (attempt === MAX_ATTEMPTS - 1 || Date.now() + wait > DEADLINE) throw new ApiFail(429, "BuiltByBit rate limit hit; waiting " + Math.ceil(wait / 1000) + " s as asked.");
      continue;
    }
    const text = await res.text();
    let data: Obj = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
    if (!res.ok || data?.result === "error") {
      const msg = data?.error?.message || data?.message || `BuiltByBit returned ${res.status}.`;
      throw new ApiFail(res.status, String(msg));
    }
    return data;
  }
  throw new ApiFail(500, "BuiltByBit request failed.");
}

async function pages(token: string, basePath: string, listKey: string, onPage: (rows: Obj[], page: number) => Promise<boolean | void>) {
  let page = 1, maxPage = 1;
  do {
    const sep = basePath.includes("?") ? "&" : "?";
    const d = await v2(token, `${basePath}${sep}page=${page}&per_page=${PER_PAGE}`);
    const rows: Obj[] = Array.isArray(d?.data?.[listKey]) ? d.data[listKey] : [];
    maxPage = num(d?.data?.stats?.max_page, 1);
    if (!rows.length) break;
    if ((await onPage(rows, page)) === true) break;
    page++;
  } while (page <= maxPage);
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

    const token = Deno.env.get("BUILTBYBIT_API_TOKEN");
    if (!token) return json({ ok: true, configured: false });
    if (action !== "sync") return json({ ok: false, error: "Unknown action." }, 400);
    const force = body.force === true;

    const nowMs = Date.now();
    const { data: st0 } = await admin.from("bbb2_state").select("*").eq("id", true).maybeSingle();
    const st: Obj = st0 ?? {};
    // A Retry-After cooldown from an earlier run still applies (even to "Sync now").
    const savedCooldown = st.cooldown_until ? new Date(String(st.cooldown_until)).getTime() : 0;
    if (savedCooldown > nowMs) {
      COOLDOWN_UNTIL = Math.max(COOLDOWN_UNTIL, savedCooldown);
      return json({ ok: true, configured: true, skipped: "BuiltByBit asked us to wait until " + new Date(savedCooldown).toISOString() });
    }
    const age = (t: unknown) => (t ? nowMs - new Date(String(t)).getTime() : Infinity);
    const fullDue = force || age(st.purchases_full_at) >= PURCHASES_FULL_EVERY_MS;
    DEADLINE = Date.now() + (fullDue ? FULL_BUDGET_MS : QUICK_BUDGET_MS);
    // One run at a time: take the lock unless another run holds it (it frees itself
    // 30 s after that run's deadline if the run died).
    const lockUntil = new Date(DEADLINE + 30000).toISOString();
    if (st0) {
      const { data: got } = await admin.from("bbb2_state").update({ running_until: lockUntil }).eq("id", true)
        .or("running_until.is.null,running_until.lt." + new Date().toISOString()).select("id");
      if (!got || !got.length) return json({ ok: true, configured: true, skipped: "another sync is running" });
    }
    const patch: Obj = {};
    const errors: string[] = [];
    const summary: Obj = {};

    // 1) purchases (account-wide). Quick read: newest pages only, stopping at the first page
    //    that is entirely stored already (checked newest-first on page 1). Full read daily.
    try {
      const full = fullDue;
      const known = new Set<number>();
      if (!full) {
        const { data } = await admin.from("bbb2_purchases").select("purchase_id").order("created_at", { ascending: false }).limit(3000);
        for (const r of (data ?? []) as Obj[]) known.add(Number(r.purchase_id));
      }
      let newestFirst = false, stored = 0, pagesRead = 0;
      // with=Buyer adds the buyer (username, avatar) to each purchase; with=Addon gives an
      // add-on purchase its add-on (title, and the listing it belongs to).
      await pages(token, "/v2/resources/creator/purchases?with=Buyer,Addon", "purchases", async (rows, page) => {
        pagesRead = page;
        if (page === 1) {
          const ts = rows.map((p) => num(p.created_at)).filter((n) => n > 0);
          newestFirst = ts.length > 1 && ts[0] >= ts[ts.length - 1];
        }
        const out = rows.map((p) => ({
          purchase_id: num(p.purchase_id),
          resource_id: p.Resource?.resource_id ?? p.addon?.resource_id ?? p.Addon?.resource_id ?? (p.content_type === "resource" ? num(p.content_id) : null),
          content_type: p.content_type ?? null,
          created_at: iso(p.created_at),
          validated_at: iso(p.validated_at),
          price_final: num(p.FinalPrice?.value),
          price_list: num(p.ListPrice?.value),
          fee: num(p.PlatformFee?.value),
          // Featured-ad fee taken from this sale (0 unless it came through a featured placement)
          // and any ad credit BuiltByBit applied to it.
          ad_fee: p.AdFeePayment ? num(p.AdFeePayment.value) : null,
          ad_fee_credit: p.AdFeeCredit ? num(p.AdFeeCredit.value) : null,
          currency: p.FinalPrice?.currency ?? null,
          gateway: p.gateway ?? null,
          bundle_id: p.bundle_id ? num(p.bundle_id) : null,
          sale_event_id: p.sale_event_id ? num(p.sale_event_id) : null,
          buyer_id: p.buyer_id ? num(p.buyer_id) : (p.Buyer?.user_id ? num(p.Buyer.user_id) : null),
          buyer_name: p.Buyer?.username ?? null,
          buyer_avatar: p.Buyer?.avatar_url_small ?? p.Buyer?.avatar_url_medium ?? null,
          external_tid: p.external_tid ?? null,
          // with=Addon comes back as a lower-case "addon" key.
          addon_title: p.addon?.title ?? p.Addon?.title ?? null,
        })).filter((r) => r.purchase_id && r.created_at);
        if (out.length) {
          const { error } = await admin.from("bbb2_purchases").upsert(out, { onConflict: "purchase_id" });
          if (error) throw new Error("save purchases: " + error.message);
          stored += out.length;
        }
        if (!full && newestFirst && rows.every((p) => known.has(num(p.purchase_id)))) return true;
      });
      patch.purchases_at = new Date().toISOString();
      if (full) patch.purchases_full_at = patch.purchases_at;
      summary.purchases = { mode: full ? "full" : "quick", stored, pages: pagesRead };
    } catch (e) { errors.push("purchases: " + (e as Error).message); }

    // 2) listings (price, description, images)
    try {
      if (force || age(st.resources_at) >= RESOURCES_EVERY_MS) {
        let n = 0;
        await pages(token, "/v2/resources/creator/resources?with=Description,Category", "resources", async (rows) => {
          const out = rows.map((r) => ({
            resource_id: num(r.resource_id),
            title: r.title ?? null,
            url: r.url ?? null,
            summary: r.summary ?? null,
            description: plain(r.Description?.bbcode || r.Description?.html).slice(0, 8000),
            list_price: r.ListPrice ? num(r.ListPrice.value) : null,
            final_price: r.FinalPrice ? num(r.FinalPrice.value) : null,
            currency: r.ListPrice?.currency ?? null,
            cover_image_url: r.cover_image_url ?? null,
            carousel_count: Array.isArray(r.carousel_image_urls) ? r.carousel_image_urls.length : 0,
            carousel_image_urls: Array.isArray(r.carousel_image_urls) ? r.carousel_image_urls.filter((u: unknown) => typeof u === "string") : [],
            category: r.Category?.title ?? null,
            // The API names these purchase_count / download_count.
            purchases: r.purchase_count ?? r.purchases ?? null,
            downloads: r.download_count ?? r.downloads ?? null,
            review_count: r.review_count ?? null,
            review_average: r.review_average ?? null,
            latest_version: r.LatestVersion?.version_string ?? null,
            published_at: iso(r.published_at),
            last_updated_at: iso(r.last_updated_at),
            synced_at: new Date().toISOString(),
          })).filter((r) => r.resource_id);
          if (out.length) {
            const { error } = await admin.from("bbb2_resources").upsert(out, { onConflict: "resource_id" });
            if (error) throw new Error("save resources: " + error.message);
            n += out.length;
          }
        });
        patch.resources_at = new Date().toISOString();
        summary.resources = n;
      }
    } catch (e) { errors.push("resources: " + (e as Error).message); }

    // 2b) reviews: every review on our listings (one request per 100). A new one is published on
    //     its coldd.dev product; one whose listing is not on the catalog is not kept (it is read
    //     again every run and imported once that product is added). Reviews pinned to the
    //     homepage (home_pin) are never removed.
    try {
      if (force || age(st.reviews_at) >= REVIEWS_EVERY_MS) {
        const firstRun = !st.reviews_at;
        const { data: resRows } = await admin.from("bbb2_resources").select("resource_id, title, final_price").limit(5000);
        const resById = new Map<number, Obj>();
        for (const r of (resRows ?? []) as Obj[]) resById.set(Number(r.resource_id), r);
        const list: PlatformReview[] = [];
        await pages(token, "/v2/resources/creator/reviews?with=Reviewer,Resource", "reviews", async (rows) => {
          for (const r of rows) {
            const rid = num(r.resource_id);
            const listing = resById.get(rid);
            const member: Obj = r.Reviewer ?? r.reviewer ?? {};
            const resource: Obj = r.Resource ?? r.resource ?? {};
            const created = iso(r.created_at);
            const stars = Math.round(num(r.stars));
            if (!r.review_id || !created) continue;
            const reply = plain(r.response);
            list.push({
              external_id: "bbb:" + r.review_id, source: "BuiltByBit",
              listing_name: String(listing?.title ?? resource.title ?? ""), listing_ref: String(rid || ""),
              bbb_resource_id: rid || null, price_usd: listing?.final_price != null ? num(listing.final_price) : null,
              stars: stars >= 1 && stars <= 5 ? stars : null, recommended: null, text: plain(r.message),
              user_name: member.username ? String(member.username) : null,
              avatar_url: member.avatar_url_medium ?? member.avatar_url_small ?? member.avatar_url_large ?? null,
              reply: reply || null, reply_at: null, created_at: created,
            });
          }
        });
        // Listings buyers can no longer see (unpublished or removed) keep no reviews here: BuiltByBit's
        // public listing search only returns visible listings, so a reviewed listing missing from it
        // is skipped and its stored reviews are removed. If none come back at all the search left our
        // listings out, so nothing is removed on that run.
        const ids = [...new Set(list.map((r) => Number(r.bbb_resource_id)).filter((n) => n > 0))];
        const visible = new Set<number>();
        let canCheck = true;
        for (let i = 0; i < ids.length && canCheck; i += 100) {
          try {
            const d = await v2(token, "/v2/resources/discover/resources?per_page=100&resource_ids=" + ids.slice(i, i + 100).join(","));
            for (const r of (Array.isArray(d?.data?.resources) ? d.data.resources : []) as Obj[]) visible.add(num(r.resource_id));
          } catch (e) {
            // The search needs the token's discover scope; without it nothing is checked or removed.
            if (e instanceof ApiFail && (e.status === 401 || e.status === 403 || /scope/i.test(e.message))) { canCheck = false; summary.listingCheck = { skipped: e.message }; }
            else throw e;
          }
        }
        const shown = ids.filter((id) => visible.has(id));
        const gone = canCheck && shown.length ? ids.filter((id) => !visible.has(id)) : [];
        if (canCheck) summary.listingCheck = { held: false, asked: ids.length, visible: shown.length, gone: gone.length, goneTitles: gone.slice(0, 15).map((id) => resById.get(id)?.title ?? id) };
        // More than half gone at once means the search changed, not that half the listings were
        // unpublished: nothing is removed and the run says so.
        if (gone.length > ids.length / 2) { summary.listingCheck.held = true; errors.push("reviews: " + gone.length + " of " + ids.length + " reviewed listings look unpublished; nothing removed"); }
        else if (gone.length) {
          const goneSet = new Set(gone);
          for (let i = list.length - 1; i >= 0; i--) if (goneSet.has(Number(list[i].bbb_resource_id))) list.splice(i, 1);
          const { error: delErr } = await admin.from("reviews").delete().eq("source", "BuiltByBit").is("home_pin", null).in("listing_ref", gone.map(String));
          if (delErr) throw new Error("remove unpublished: " + delErr.message);
        }
        const matcher = await buildMatcher(admin);
        const saved = await savePlatformReviews(admin, list, { markSeen: firstRun, matcher, skipUnmatched: true });
        const swept = await sweepUnmatched(admin, matcher);
        patch.reviews_at = new Date().toISOString();
        summary.reviews = { ...saved, swept };
      }
    } catch (e) { errors.push("reviews: " + (e as Error).message); }

    // 3) funnel: overall + each BuiltByBit listing that matches a coldd product by title. Resumable:
    //    every (listing, period) pair has its own refresh age, each run does the stalest due pairs
    //    until the time budget is spent and the next run carries on.
    try {
      const { data: prods } = await admin.from("products").select("title");
      const ours = new Set(((prods ?? []) as Obj[]).map((p) => norm(p.title)));
      const { data: res } = await admin.from("bbb2_resources").select("resource_id, title").limit(5000);
      const subjects: number[] = [0];
      for (const r of (res ?? []) as Obj[]) if (ours.has(norm(r.title))) subjects.push(Number(r.resource_id));
      const day = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
      // BuiltByBit's "30 days" runs from 30 days ago through today, so these windows do too
      const periods: Array<[string, string]> = [["1", day(1)], ["7", day(7)], ["30", day(30)], ["90", day(90)], ["all", "2023-01-01"]];
      // Funnel figures (page views, impressions, cart adds) move slowly: every listing's 1/7/30-day
      // figures refresh every 6 hours, 90-day and all-time daily. At 30 minutes this was ~1
      // request a second non-stop (and drew BuiltByBit's Retry-After); now it is a few a minute.
      const TTL: Record<string, number> = { "1": 6 * 3600e3, "7": 6 * 3600e3, "30": 6 * 3600e3, "90": 24 * 3600e3, "all": 24 * 3600e3 };
      const ids = ["resources-base-total-page-views", "resources-base-total-impressions", "resources-base-total-cart-adds",
        "resources-base-total-wishlist-adds", "resources-base-total-purchases"]; // the API allows at most 5 per request; revenue comes from the purchases table
      const { data: have } = await admin.from("bbb2_funnel").select("resource_id, period, fetched_at").limit(5000);
      const fetched = new Map<string, number>();
      for (const r of (have ?? []) as Obj[]) fetched.set(r.resource_id + ":" + r.period, new Date(r.fetched_at).getTime());
      const jobs: Array<{ rid: number; label: string; start: string; last: number }> = [];
      for (const rid of subjects) for (const [label, start] of periods) {
        const last = fetched.get(rid + ":" + label) ?? 0;
        if (force || Date.now() - last >= TTL[label]) jobs.push({ rid, label, start, last });
      }
      jobs.sort((x, y) => x.last - y.last || x.rid - y.rid);
      let done = 0;
      for (const j of jobs) {
        if (overBudget()) break;
        const q = "/v2/analytics/single?analytics=" + ids.join(",") + "&period=custom_range&start_date=" + j.start + "&end_date=" + day(0) +
          (j.rid ? "&filters[resource_ids]=" + j.rid : "");
        let d: Obj;
        try { d = await v2(token, q); } catch (e) { if (e instanceof ApiFail && e.status === 408) break; throw e; }
        const a: Obj = d?.data?.analytics ?? {};
        const { error } = await admin.from("bbb2_funnel").upsert({
          resource_id: j.rid, period: j.label,
          page_views: Math.round(num(a[ids[0]])), impressions: Math.round(num(a[ids[1]])), cart_adds: Math.round(num(a[ids[2]])),
          wishlist_adds: Math.round(num(a[ids[3]])), purchases: Math.round(num(a[ids[4]])),
          fetched_at: new Date().toISOString(),
        }, { onConflict: "resource_id,period" });
        if (error) throw new Error("save funnel: " + error.message);
        done++;
      }
      patch.funnel_at = new Date().toISOString();
      summary.funnel = { subjects: subjects.length, due: jobs.length, done };
    } catch (e) { errors.push("funnel: " + (e as Error).message); }

    patch.last_error = errors.length ? errors.join("; ").slice(0, 500) : null;
    patch.cooldown_until = COOLDOWN_UNTIL > Date.now() ? new Date(COOLDOWN_UNTIL).toISOString() : null;
    patch.running_until = null;
    patch.updated_at = new Date().toISOString();
    await admin.from("bbb2_state").upsert({ id: true, ...patch }, { onConflict: "id" });
    if (errors.length) console.warn("[admin-bbb-v2-sync] partial:", errors);
    // New sales just saved: send their phone alerts now (the database trigger and the
    // sale-alerts cron job are the backups).
    await flushSaleAlerts(admin).catch(() => null);
    return json({ ok: true, configured: true, syncedAt: patch.updated_at, summary, errors });
  } catch (err) {
    console.error("[admin-bbb-v2-sync] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
