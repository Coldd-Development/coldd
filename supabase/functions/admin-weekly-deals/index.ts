// supabase/functions/admin-weekly-deals/index.ts
//
// Deploy with:
//   supabase functions deploy admin-weekly-deals --no-verify-jwt
//
// Required secret (set once):
//   supabase secrets set CRON_SECRET=<random-value>
//
// --no-verify-jwt is intentional, same reason as lock-check: the weekly
// cron job (pg_cron + pg_net, see the matching migration) calls this with
// no user session at all, just the CRON_SECRET header. Every other action
// (revert/exclude/include, and a manual "Run now" from the admin panel)
// carries a real admin JWT instead and is checked the normal way.
//
// Powers the homepage "This week's deals" grid: picks which products get
// discounted and by how much, writing straight to products.price_usd /
// was_price - the exact same fields the admin product editor's own "Was
// price" field already writes for a manual sale, so nothing downstream
// (catalog cards, checkout, cart) needs to know this ran at all.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://coldd.dev";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

const DEFAULT_MAX_DISCOUNT_PCT = 40;
const DEFAULT_DISCOUNT_STEP_PCT = 5;
const PICK_COUNT = 4;

async function loadSettings(admin: ReturnType<typeof createClient>) {
  const { data } = await admin.from("weekly_deal_settings").select("max_discount_pct, discount_step_pct").eq("id", true).maybeSingle();
  return {
    maxDiscountPct: data?.max_discount_pct ?? DEFAULT_MAX_DISCOUNT_PCT,
    discountStepPct: data?.discount_step_pct ?? DEFAULT_DISCOUNT_STEP_PCT,
  };
}

type ProductRow = {
  id: string;
  slug: string;
  title: string;
  price_usd: number;
  was_price: number | null;
  weekly_deal_auto: boolean;
  weekly_deal_excluded: boolean;
  is_active: boolean;
};

async function revertAuto(admin: ReturnType<typeof createClient>, ids?: string[]) {
  let q = admin
    .from("products")
    .update({ weekly_deal: false, weekly_deal_auto: false, weekly_deal_pct: null })
    .eq("weekly_deal_auto", true);
  if (ids && ids.length) q = q.in("id", ids);
  const { data: toRevert } = await q.select("id, was_price");
  // price_usd/was_price need each row's own was_price, which .update()
  // can't reference per-row - a second pass per row is unavoidable here,
  // but this only ever runs over a handful of currently-discounted
  // products (PICK_COUNT is 4), never the whole catalog.
  for (const row of toRevert ?? []) {
    if (row.was_price != null) {
      await admin.from("products").update({ price_usd: row.was_price, was_price: null }).eq("id", row.id);
    }
  }
  return toRevert ?? [];
}

// ---------------------------------------------------------------------------
// Demand scoring + discount-depth learning
//
// WHICH products: a blended demand score from real signals we have today:
//   - BuiltByBit sales of the same listing (direct title match) and of similar
//     listings (shared keywords), recency weighted
//   - on-site product page views (last 14 days)
//   - on-site paid units (last 30 days)
// Weights re-normalise over whichever signals actually have data, so the score
// leans on site sales more and more as they accumulate. The single strongest
// seller is damped (it sells without help) and anything discounted in the last
// two weeks is rotated out.
//
// HOW DEEP: every deal row is logged in weekly_deal_history. The next run closes
// the row with the views / units it earned, and a Thompson-sampling bandit picks
// each product's discount from those results: conversion rate per depth is a
// Beta posterior, and the pick maximises (1 - depth) x sampled conversion, i.e.
// expected revenue per visitor. No made-up elasticity; with no data yet it
// explores evenly, and it converges as results come in.
// ---------------------------------------------------------------------------
const BBB_HALF_LIFE_DAYS = 30;
const BBB_LOOKBACK_DAYS = 120;
const VIEW_LOOKBACK_DAYS = 14;
const ROTATE_OUT_DAYS = 14;
const MAX_ARMS = 5;
const PRIOR_CONV_ALPHA = 1;
const PRIOR_CONV_BETA = 24; // ~4% starting guess; real data swamps it

function normTitle(t: string) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
// Filler words are detected from the data, not listed by hand: a word is "common" when it appears in
// more than 10% of a large reference corpus (product title+description plus BuiltByBit title+summary).
function words(t: string) {
  return String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}
function commonWords(docs: string[]): Set<string> {
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(words(d))) df.set(w, (df.get(w) || 0) + 1);
  const out = new Set<string>();
  if (docs.length >= 50) for (const [w, n] of df) if (n > 0.1 * docs.length) out.add(w);
  return out;
}
function tokens(t: string, common: Set<string>) {
  return new Set(words(t).filter((w) => !common.has(w)));
}

// Standard normal + gamma + beta samplers (Marsaglia-Tsang) for Thompson sampling.
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gammaSample(k: number): number {
  if (k < 1) return gammaSample(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0, v = 0;
    do { x = randn(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function betaSample(a: number, b: number) {
  const x = gammaSample(a), y = gammaSample(b);
  return x / (x + y);
}

function pickArms(step: number, max: number): number[] {
  const all: number[] = [];
  for (let p = step; p <= max; p += step) all.push(p);
  if (all.length <= MAX_ARMS) return all;
  const out: number[] = [];
  for (let i = 0; i < MAX_ARMS; i++) out.push(all[Math.round((i * (all.length - 1)) / (MAX_ARMS - 1))]);
  return Array.from(new Set(out));
}

// Close any open history rows: how many views / units / revenue each deal earned.
async function finalizeHistory(admin: ReturnType<typeof createClient>) {
  const { data: open } = await admin.from("weekly_deal_history").select("id, product_id, started_at").is("ended_at", null);
  if (!open?.length) return;
  const nowIso = new Date().toISOString();
  const ids = Array.from(new Set(open.map((r: { product_id: string }) => r.product_id)));
  const { data: prods } = await admin.from("products").select("id, slug").in("id", ids);
  const slugById = new Map((prods ?? []).map((p: { id: string; slug: string }) => [p.id, p.slug]));
  for (const row of open as Array<{ id: number; product_id: string; started_at: string }>) {
    const slug = slugById.get(row.product_id);
    let views = 0, units = 0, revenue = 0;
    if (slug) {
      const { count } = await admin.from("page_views").select("id", { count: "exact", head: true })
        .in("path", [`/product/${slug}`, `/product/${slug}/`]).gte("created_at", row.started_at).lte("created_at", nowIso);
      views = count || 0;
      const { data: items } = await admin.from("order_items").select("qty, unit_price_usd, licence, orders!inner(status, created_at)")
        .eq("product_id", row.product_id).eq("orders.status", "paid").gte("orders.created_at", row.started_at).lte("orders.created_at", nowIso);
      for (const it of items ?? []) {
        // deno-lint-ignore no-explicit-any
        const r = it as any;
        if (r.licence === "resell") continue;
        const q = Number(r.qty) || 0;
        units += q;
        revenue += q * (Number(r.unit_price_usd) || 0);
      }
    }
    await admin.from("weekly_deal_history").update({ ended_at: nowIso, views, units, revenue }).eq("id", row.id);
  }
}

async function runAlgorithm(admin: ReturnType<typeof createClient>, actorName: string, dryRun = false) {
  // Close last week's rows with their results, then restore real prices so we
  // always score from true baseline prices (re-running can never compound).
  if (!dryRun) {
    await finalizeHistory(admin);
    await revertAuto(admin);
  }

  const { maxDiscountPct: MAX_DISCOUNT_PCT, discountStepPct: DISCOUNT_STEP_PCT } = await loadSettings(admin);
  const arms = pickArms(DISCOUNT_STEP_PCT, MAX_DISCOUNT_PCT);

  const { data: products, error: prodErr } = await admin
    .from("products")
    .select("id, slug, title, description, cat, subcat, price_usd, was_price, weekly_deal_auto, created_at, weekly_deal_excluded, product_legal(min_sale_usd, disallow_sales, max_discount_pct)")
    .eq("is_active", true);
  if (prodErr) throw new Error(prodErr.message);

  const now = Date.now();
  const since30 = new Date(now - 30 * 86400000).toISOString();

  // --- signal 1: on-site paid units (30d) ---
  const { data: sales } = await admin
    .from("order_items").select("product_id, qty, orders!inner(status, created_at)")
    .eq("orders.status", "paid").neq("licence", "resell").gte("orders.created_at", since30);
  const siteUnits = new Map<string, number>();
  for (const row of sales ?? []) {
    // deno-lint-ignore no-explicit-any
    const r = row as any;
    siteUnits.set(r.product_id, (siteUnits.get(r.product_id) || 0) + (Number(r.qty) || 0));
  }

  // --- signal 2: on-site product page views (14d) ---
  const sinceViews = new Date(now - VIEW_LOOKBACK_DAYS * 86400000).toISOString();
  const { data: views } = await admin.from("page_views").select("path").like("path", "/product/%").gte("created_at", sinceViews).limit(50000);
  const viewsBySlug = new Map<string, number>();
  for (const v of views ?? []) {
    const slug = String((v as { path: string }).path).replace(/^\/product\//, "").replace(/\/$/, "");
    if (slug) viewsBySlug.set(slug, (viewsBySlug.get(slug) || 0) + 1);
  }

  // --- signal 3: BuiltByBit sales, direct (same listing) and thematic (similar listings) ---
  const sinceBbb = new Date(now - BBB_LOOKBACK_DAYS * 86400000).toISOString();
  const { data: bbbRes } = await admin.from("bbb2_resources").select("resource_id, title");
  const { data: bbbSales } = await admin.from("bbb2_purchases").select("resource_id, created_at").gte("created_at", sinceBbb).limit(50000);
  const weightByRes = new Map<string, number>();
  for (const s of bbbSales ?? []) {
    const r = s as { resource_id: string; created_at: string };
    const ageDays = Math.max(0, (now - new Date(r.created_at).getTime()) / 86400000);
    weightByRes.set(String(r.resource_id), (weightByRes.get(String(r.resource_id)) || 0) + Math.pow(0.5, ageDays / BBB_HALF_LIFE_DAYS));
  }
  const { data: bbbText } = await admin.from("bbb2_resources").select("title, summary");
  const corpus: string[] = [
    ...((products ?? []) as Array<{ title: string; description?: string }>).map((p) => `${p.title || ""} ${p.description || ""}`),
    ...((bbbText ?? []) as Array<{ title: string; summary: string | null }>).map((r) => `${r.title || ""} ${r.summary || ""}`),
  ];
  const common = commonWords(corpus);
  const bbbList = (bbbRes ?? []).map((r: { resource_id: string; title: string }) => ({
    key: normTitle(r.title), toks: tokens(r.title, common), w: weightByRes.get(String(r.resource_id)) || 0,
  })).filter((r) => r.w > 0);

  // --- last weeks' deals (rotation) and learned results per depth ---
  const { data: hist } = await admin.from("weekly_deal_history").select("product_id, pct, started_at, views, units, ended_at");
  const recentlyDealt = new Set<string>();
  const armStats = new Map<number, { views: number; units: number }>();
  for (const h of (hist ?? []) as Array<{ product_id: string; pct: number; started_at: string; views: number | null; units: number | null; ended_at: string | null }>) {
    if (now - new Date(h.started_at).getTime() < ROTATE_OUT_DAYS * 86400000) recentlyDealt.add(h.product_id);
    if (h.ended_at) {
      const st = armStats.get(h.pct) || { views: 0, units: 0 };
      st.views += h.views || 0; st.units += h.units || 0;
      armStats.set(h.pct, st);
    }
  }

  type Legal = { min_sale_usd: number; disallow_sales: boolean; max_discount_pct: number };
  type Row = ProductRow & { cat: string; subcat: string | null; product_legal: Legal | Legal[] | null };
  type Cand = { id: string; slug: string; title: string; cat: string; price: number; maxPct: number; direct: number; theme: number; views: number; units: number; score: number };
  const cands: Cand[] = [];
  for (const p of (products ?? []) as unknown as Row[]) {
    if (p.weekly_deal_excluded) continue;
    const legal = Array.isArray(p.product_legal) ? p.product_legal[0] : p.product_legal;
    if (legal?.disallow_sales) continue;
    // A dry run sees live discounted prices; score from the real (pre-deal) price.
    const price = (p.weekly_deal_auto && p.was_price != null ? Number(p.was_price) : Number(p.price_usd)) || 0;
    if (price <= 0) continue;
    let maxPct = MAX_DISCOUNT_PCT;
    const minSaleUsd = Number(legal?.min_sale_usd) || 0;
    if (minSaleUsd > 0 && minSaleUsd < price) maxPct = Math.min(maxPct, Math.floor(100 * (1 - minSaleUsd / price)));
    else if (minSaleUsd >= price) continue;
    const legalMax = Number(legal?.max_discount_pct) || 0;
    if (legalMax > 0) maxPct = Math.min(maxPct, Math.floor(legalMax));
    if (!arms.length || maxPct < Math.min(...arms)) continue;

    const key = normTitle(p.title), toks = tokens(p.title, common);
    let direct = 0, theme = 0;
    for (const r of bbbList) {
      if (r.key === key) { direct += r.w; continue; }
      let shared = 0;
      toks.forEach((t) => { if (r.toks.has(t)) shared++; });
      if (shared > 0) theme += r.w * (shared / Math.max(1, Math.min(toks.size, r.toks.size))) * 0.5;
    }
    cands.push({ id: p.id, slug: p.slug, title: p.title, cat: p.cat, price, maxPct, direct, theme, views: viewsBySlug.get(p.slug) || 0, units: siteUnits.get(p.id) || 0, score: 0 });
  }

  // Blend: log-scaled, each signal 0..1 against the best product, weights re-normalised
  // over signals that have any data at all.
  const sig = [
    { w: 0.35, f: (c: Cand) => Math.log1p(c.direct) },
    { w: 0.20, f: (c: Cand) => Math.log1p(c.theme) },
    { w: 0.25, f: (c: Cand) => Math.log1p(c.views) },
    { w: 0.20, f: (c: Cand) => Math.log1p(c.units) },
  ].map((s) => ({ ...s, max: Math.max(0, ...cands.map(s.f)) })).filter((s) => s.max > 0);
  const wSum = sig.reduce((a, s) => a + s.w, 0) || 1;
  for (const c of cands) c.score = sig.reduce((a, s) => a + (s.w / wSum) * (s.f(c) / s.max), 0);

  // Opportunity: damp the runaway best seller, rotate out recent deals, add small jitter so ties rotate.
  const topScore = Math.max(0, ...cands.map((c) => c.score));
  const ranked = cands.map((c) => {
    let opp = c.score;
    if (topScore > 0 && c.score >= 0.9 * topScore) opp *= 0.75;
    if (recentlyDealt.has(c.id)) opp *= 0.6;
    return { c, opp: opp * (0.9 + Math.random() * 0.2) };
  }).sort((a, b) => b.opp - a.opp);

  const perCat = new Map<string, number>();
  const picks: Array<{ c: Cand; pct: number }> = [];
  for (const { c } of ranked) {
    if (picks.length >= PICK_COUNT) break;
    if ((perCat.get(c.cat) || 0) >= 2) continue;
    perCat.set(c.cat, (perCat.get(c.cat) || 0) + 1);
    // Thompson sampling over allowed depths: maximise (1 - depth) x sampled conversion.
    let bestPct = 0, bestVal = -1;
    for (const a of arms) {
      if (a > c.maxPct) continue;
      const st = armStats.get(a) || { views: 0, units: 0 };
      const conv = betaSample(PRIOR_CONV_ALPHA + st.units, PRIOR_CONV_BETA + Math.max(0, st.views - st.units));
      const val = (1 - a / 100) * conv;
      if (val > bestVal) { bestVal = val; bestPct = a; }
    }
    if (bestPct > 0) picks.push({ c, pct: bestPct });
  }
  // Not enough distinct categories to fill the grid: relax the per-category limit.
  if (picks.length < PICK_COUNT) {
    for (const { c } of ranked) {
      if (picks.length >= PICK_COUNT) break;
      if (picks.some((p) => p.c.id === c.id)) continue;
      const allowed = arms.filter((a) => a <= c.maxPct);
      if (!allowed.length) continue;
      picks.push({ c, pct: allowed[0] });
    }
  }

  if (dryRun) {
    return picks.map((p) => ({ slug: p.c.slug, title: p.c.title, pct: p.pct, score: Math.round(p.c.score * 100) / 100, direct: Math.round(p.c.direct * 10) / 10, theme: Math.round(p.c.theme * 10) / 10, views: p.c.views, units: p.c.units }));
  }

  for (const { c, pct } of picks) {
    const discPrice = Math.round(c.price * (1 - pct / 100) * 100) / 100;
    await admin.from("products").update({
      price_usd: discPrice, was_price: c.price, weekly_deal: true, weekly_deal_auto: true, weekly_deal_pct: pct,
    }).eq("id", c.id);
    await admin.from("weekly_deal_history").insert({
      product_id: c.id, pct, price_before: c.price, price_after: discPrice, demand_score: Math.round(c.score * 1000) / 1000,
    });
  }

  await admin.from("admin_audit_log").insert({
    actor_id: null,
    actor_name: actorName,
    action: picks.length
      ? `Weekly deals: ${picks.map((p) => `${p.c.title} (-${p.pct}%)`).join(", ")}`
      : "Weekly deals: no eligible products found",
  });

  return picks.map((p) => ({ slug: p.c.slug, title: p.c.title, pct: p.pct }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    const cronSecret = Deno.env.get("CRON_SECRET") || "";
    const providedSecret = req.headers.get("x-cron-secret") || "";
    const isCron = cronSecret.length > 0 && providedSecret === cronSecret;

    let actorName = "system (weekly deals cron)";
    if (!isCron) {
      // Every non-cron action needs a real signed-in admin - the cron
      // secret only ever authorizes 'run', never exclude/include/revert.
      const authHeader = req.headers.get("Authorization") ?? "";
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);
      const { data: profile, error: profileErr } = await admin
        .from("profiles")
        .select("is_admin, username")
        .eq("id", userData.user.id)
        .single();
      if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
      actorName = profile.username || "admin";
    }

    if (action === "run") {
      const picks = await runAlgorithm(admin, isCron ? actorName : `${actorName} (manual run)`, body.dryRun === true);
      return json({ ok: true, picks });
    }

    if (action === "getSettings") {
      const settings = await loadSettings(admin);
      return json({ ok: true, ...settings });
    }

    if (action === "updateSettings") {
      if (isCron) return json({ ok: false, error: "Not permitted." }, 403);
      const maxDiscountPct = Math.round(Number(body.maxDiscountPct));
      const discountStepPct = Math.round(Number(body.discountStepPct));
      if (!Number.isFinite(maxDiscountPct) || maxDiscountPct <= 0 || maxDiscountPct > 90) {
        return json({ ok: false, error: "Max discount must be between 1 and 90." }, 400);
      }
      if (!Number.isFinite(discountStepPct) || discountStepPct <= 0 || discountStepPct > maxDiscountPct) {
        return json({ ok: false, error: "Discount step must be between 1 and the max discount." }, 400);
      }
      const { error: settingsErr } = await admin.from("weekly_deal_settings").upsert({
        id: true,
        max_discount_pct: maxDiscountPct,
        discount_step_pct: discountStepPct,
        updated_at: new Date().toISOString(),
      });
      if (settingsErr) throw new Error(settingsErr.message);
      await admin.from("admin_audit_log").insert({
        actor_id: null,
        actor_name: actorName,
        action: `Weekly deals settings: max ${maxDiscountPct}%, step ${discountStepPct}%`,
      });
      return json({ ok: true });
    }

    if (action === "revertAll") {
      if (isCron) return json({ ok: false, error: "Not permitted." }, 403);
      const reverted = await revertAuto(admin);
      await admin.from("admin_audit_log").insert({ actor_id: null, actor_name: actorName, action: `Reverted all ${reverted.length} weekly deal(s)` });
      return json({ ok: true, reverted: reverted.length });
    }

    if (action === "revert" || action === "exclude" || action === "include") {
      if (isCron) return json({ ok: false, error: "Not permitted." }, 403);
      const productId = String(body.productId || "");
      if (!productId) return json({ ok: false, error: "productId is required." }, 400);

      if (action === "revert") {
        await revertAuto(admin, [productId]);
        await admin.from("admin_audit_log").insert({ actor_id: null, actor_name: actorName, action: `Reverted weekly deal on product ${productId}` });
      } else if (action === "exclude") {
        await admin.from("products").update({ weekly_deal_excluded: true }).eq("id", productId);
        await revertAuto(admin, [productId]);
        await admin.from("admin_audit_log").insert({ actor_id: null, actor_name: actorName, action: `Excluded product ${productId} from weekly deals` });
      } else {
        await admin.from("products").update({ weekly_deal_excluded: false }).eq("id", productId);
        await admin.from("admin_audit_log").insert({ actor_id: null, actor_name: actorName, action: `Re-included product ${productId} in weekly deals` });
      }
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[admin-weekly-deals] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
