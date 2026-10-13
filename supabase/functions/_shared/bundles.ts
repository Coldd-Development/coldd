// supabase/functions/_shared/bundles.ts
//
// Everything about curated bundles that has to be decided on the server:
//   - how much discount a set of products can legally take (product_legal
//     price floors, discount caps, "do not discount"), in USD and in Robux
//   - whether a bundle may be created at all
//   - which bundles to suggest, from product genre / keywords
//
// priceItems() (coupon.ts) still clamps every bundle line to the product's
// own floor at checkout - that is the backstop. This file is the front door:
// a bundle that cannot respect a floor is refused when it is created, and is
// never suggested, so it can never be discounting anything in the first place.


// Flat estimate used when a product has no Robux price of its own. Must match
// ROBUX_PER_USD in roblox.ts (not imported: that module pulls in the whole Roblox client).
const ROBUX_PER_USD = 80;

export const BUNDLE_MIN_PCT = 1;
export const BUNDLE_MAX_PCT = 60;
export const BUNDLE_MIN_PRODUCTS = 2;
export const BUNDLE_MAX_PRODUCTS = 8;

const round2 = (n: number) => Math.round(n * 100) / 100;

// The columns every function here needs from `products` (+ product_legal).
export const BUNDLE_PRODUCT_COLS =
  "id, slug, title, price_usd, robux_price, robux_disabled, platform, cat, subcat, reviews_count, rating, is_active, " +
  "product_legal(min_sale_usd, min_sale_robux, max_discount_pct, can_be_free, disallow_sales)";

// deno-lint-ignore no-explicit-any
export type BundleProduct = any;

// deno-lint-ignore no-explicit-any
function legalOf(p: any) {
  const l = Array.isArray(p.product_legal) ? p.product_legal[0] : p.product_legal;
  return {
    minSaleUsd: Number(l?.min_sale_usd) || 0,
    minSaleRobux: Number(l?.min_sale_robux) || 0,
    maxDiscountPct: Math.max(0, Math.min(100, Number(l?.max_discount_pct) || 0)),
    canBeFree: !!l?.can_be_free,
    disallowSales: !!l?.disallow_sales,
  };
}

export type ProductLimit = { maxPct: number; reason: string | null };

// The biggest whole-number discount this one product can take without its
// price dropping below a floor - in USD, and in Robux when it is sold there.
// Mirrors priceItems() / priceRobuxItems(): the effective floor is the highest
// of the dollar floor, the price the max-discount cap reaches, and (unless the
// product may be free) a non-zero minimum.
export function productMaxBundlePct(p: BundleProduct): ProductLimit {
  const l = legalOf(p);
  if (l.disallowSales) return { maxPct: 0, reason: "is marked do not discount" };
  const price = Number(p.price_usd) || 0;
  if (!(price > 0)) return { maxPct: 0, reason: "is free" };

  const pctFloorUsd = l.maxDiscountPct > 0 ? round2(price * (1 - l.maxDiscountPct / 100)) : 0;
  const floorUsd = Math.max(l.minSaleUsd, pctFloorUsd, l.canBeFree ? 0 : 0.01);
  let pct = BUNDLE_MAX_PCT;
  while (pct > 0 && round2(price * (1 - pct / 100)) < floorUsd) pct--;
  let reason: string | null = null;
  if (pct < BUNDLE_MAX_PCT) {
    reason = l.minSaleUsd >= pctFloorUsd && l.minSaleUsd > 0
      ? `has a $${l.minSaleUsd.toFixed(2)} minimum sale price`
      : l.maxDiscountPct > 0 ? `has a ${l.maxDiscountPct}% maximum discount` : "cannot be discounted that far";
  }

  // Robux side, only if this product is actually sold for Robux.
  if (p.platform === "Roblox" && !p.robux_disabled) {
    const robux = Number(p.robux_price) > 0 ? Number(p.robux_price) : Math.round(price * ROBUX_PER_USD);
    const pctFloorRobux = l.maxDiscountPct > 0 ? Math.round(robux * (1 - l.maxDiscountPct / 100)) : 0;
    const floorRobux = Math.max(l.minSaleRobux, pctFloorRobux, l.canBeFree ? 0 : 1);
    let rp = BUNDLE_MAX_PCT;
    while (rp > 0 && Math.round(robux * (1 - rp / 100)) < floorRobux) rp--;
    if (rp < pct) {
      pct = rp;
      reason = l.minSaleRobux > 0 && l.minSaleRobux >= pctFloorRobux
        ? `has a ${l.minSaleRobux.toLocaleString("en-US")} Robux minimum sale price`
        : `has a ${l.maxDiscountPct}% maximum discount`;
    }
  }
  return { maxPct: Math.max(0, pct), reason };
}

export type BundleLimit = {
  maxPct: number;
  blockers: { slug: string; title: string; maxPct: number; reason: string }[];
};

// The most discount a whole set can take: the tightest limit of any member.
export function bundleMaxPct(products: BundleProduct[]): BundleLimit {
  let maxPct = BUNDLE_MAX_PCT;
  const blockers: BundleLimit["blockers"] = [];
  for (const p of products) {
    const lim = productMaxBundlePct(p);
    if (lim.maxPct < maxPct) maxPct = lim.maxPct;
    if (lim.reason) blockers.push({ slug: p.slug, title: p.title, maxPct: lim.maxPct, reason: lim.reason });
  }
  blockers.sort((a, b) => a.maxPct - b.maxPct);
  return { maxPct, blockers };
}

// null = fine; otherwise the exact reason the bundle is refused. Used by
// admin-upsert-bundle on every create / edit.
export function validateBundle(products: BundleProduct[], pct: number): string | null {
  if (products.length < BUNDLE_MIN_PRODUCTS) return `A bundle needs at least ${BUNDLE_MIN_PRODUCTS} products.`;
  if (products.length > BUNDLE_MAX_PRODUCTS) return `A bundle can have at most ${BUNDLE_MAX_PRODUCTS} products.`;
  const platforms = new Set(products.map((p) => p.platform));
  if (platforms.size > 1) return "A bundle can't mix Roblox and Minecraft products.";
  if (products.some((p) => !(Number(p.price_usd) > 0))) return "Free products can't be part of a bundle.";
  if (pct < BUNDLE_MIN_PCT || pct > BUNDLE_MAX_PCT) return `The discount must be between ${BUNDLE_MIN_PCT}% and ${BUNDLE_MAX_PCT}%.`;

  const lim = bundleMaxPct(products);
  if (lim.maxPct < BUNDLE_MIN_PCT) {
    const b = lim.blockers[0];
    return `${b ? b.title + " " + b.reason : "One of these products can't be discounted"}, so this bundle can't be discounted at all.`;
  }
  if (pct > lim.maxPct) {
    const b = lim.blockers[0];
    return `${pct}% would take ${b ? b.title : "a product"} below its price limit${b ? " (it " + b.reason + ")" : ""}. The most this bundle can discount is ${lim.maxPct}%.`;
  }
  return null;
}

// The product shown as the bundle's cover: the most popular one.
export function popularityScore(p: BundleProduct): number {
  return (Number(p.reviews_count) || 0) * 10 + (Number(p.rating) || 0);
}
export function pickCoverSlug(products: BundleProduct[]): string {
  return [...products].sort((a, b) => popularityScore(b) - popularityScore(a) || Number(b.price_usd) - Number(a.price_usd))[0].slug;
}

/* ================================================================
   SUGGESTIONS
   ================================================================

   How sets are matched, strongest signal first (mirrors the storefront's own relevance
   ranking, where genre tags outweigh category):

   1. Genre tags. Every product carries subcategory tags (vfx-packs, medieval, sci-fi, ...).
      A tag shared by 2-10 products is a ready-made "all of our X" set - e.g. the six products
      tagged vfx-packs become "VFX Packs Bundle". Tags held by many products (vfx, combat) are far
      too broad to mean anything on their own, so they only add a little to a similarity score.
   2. Nearest neighbours. For each product, the products that overlap it on several tags, rare
      title words and category - the "if you like this, you want these" sets.
   3. Rare title words (Slash, Medieval, Locomotive...), then subcategory / category, as fallbacks.

   Each candidate is then checked against every product's price limits (never suggested if it
   cannot be discounted), de-duplicated, and ranked. */

// Words that say nothing about genre when they appear in a title.
const STOP = new Set((
  "the and for with pack packs kit kits set sets system systems template templates roblox minecraft bundle collection " +
  "asset assets map maps full game games vol volume new pro lite mega starter ultimate basic advanced edition version " +
  "ui gui plugin plugins models model skins skin lobby lobbies hub setup custom pvp combat vfx"
).split(" "));

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

// Distinctive words in a title (generic ones like "pack" and "vfx" are dropped: they appear in
// half the catalogue and would link everything to everything).
export function keywordsOf(title: string): string[] {
  const out = new Set<string>();
  for (const raw of String(title || "").toLowerCase().split(/[^a-z]+/)) {
    if (!raw) continue;
    const w = stem(raw);
    if (w.length >= 4 && !STOP.has(w) && !STOP.has(raw)) out.add(w);
  }
  return [...out];
}

export function tagsOf(p: BundleProduct): string[] {
  return String(p.subcat || "").toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
}

// Tags that describe how a product is built, not what it is - never a genre on their own.
const ATTRIBUTE_TAGS = new Set(["scripted", "new", "free", "bundle"]);

const UPPER = new Set(["vfx", "rng", "ui", "gui", "npc", "scp", "scpf", "fps", "rpg", "sfx", "hud", "pvp", "2d", "3d"]);
const SPECIAL: Record<string, string> = { "sci-fi": "Sci-Fi", melees: "Melee", "trains-locomotives": "Locomotives" };
// "vfx-packs" -> "VFX Packs", "sci-fi" -> "Sci-Fi", "trains-locomotives" -> "Trains Locomotives".
export function labelOf(tag: string): string {
  if (SPECIAL[tag]) return SPECIAL[tag];
  return tag.split(/[-_ ]+/).filter(Boolean)
    .map((w) => (UPPER.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export type BundleSuggestion = {
  slugs: string[];
  coverSlug: string;
  reason: string;
  score: number;
  maxPct: number;
  suggestedPct: number;
  listUsd: number;
  bundleUsd: number;
  titleOptions: string[];
  descriptionOptions: string[];
};

type Cand = {
  set: BundleProduct[];
  score: number;
  reason: string;
  kind: "tag" | "near" | "kw" | "sub" | "cat";
  label: string; // what the set is "about", used for the title / description templates
  seedTitle?: string; // "near" sets: the product they were built around
};

const MAX_SET = 6;

export function suggestBundles(
  products: BundleProduct[],
  existing: { slugs: string[] }[],
): { suggestions: BundleSuggestion[]; blocked: number } {
  const live = products.filter((p) => p.is_active && Number(p.price_usd) > 0);
  const byPlatform = new Map<string, BundleProduct[]>();
  for (const p of live) {
    if (!byPlatform.has(p.platform)) byPlatform.set(p.platform, []);
    byPlatform.get(p.platform)!.push(p);
  }
  const top = (list: BundleProduct[], n: number) => [...list].sort((a, b) => popularityScore(b) - popularityScore(a)).slice(0, n);

  const cands: Cand[] = [];

  for (const list of byPlatform.values()) {
    const tagDf = new Map<string, BundleProduct[]>();
    const kwDf = new Map<string, BundleProduct[]>();
    for (const p of list) {
      for (const t of tagsOf(p)) { if (!tagDf.has(t)) tagDf.set(t, []); tagDf.get(t)!.push(p); }
      for (const k of keywordsOf(p.title)) { if (!kwDf.has(k)) kwDf.set(k, []); kwDf.get(k)!.push(p); }
    }
    // How much a shared tag says: a tag held by a handful of products is a real genre; one held by
    // dozens (vfx, combat) barely distinguishes anything.
    const tagWeight = (t: string) => {
      if (ATTRIBUTE_TAGS.has(t)) return 5;
      const n = tagDf.get(t)?.length ?? 0;
      return n <= 6 ? 60 : n <= 12 ? 40 : 15;
    };

    // 1. Whole tag sets: every product carrying a specific tag.
    for (const [tag, set] of tagDf) {
      if (set.length < 2 || set.length > 10 || ATTRIBUTE_TAGS.has(tag)) continue;
      const pick = top(set, MAX_SET);
      const sameCat = pick.every((p) => p.cat === pick[0].cat);
      // 3-6 products reads as a complete set; exactly 2 is thinner.
      const sizeBonus = set.length >= 3 && set.length <= 6 ? 40 : set.length === 2 ? 15 : 10;
      cands.push({
        set: pick, kind: "tag", label: labelOf(tag),
        score: 160 + sizeBonus + (sameCat ? 25 : 0) + Math.min(30, pick.reduce((sum, p) => sum + popularityScore(p), 0) / 40),
        reason: (set.length > MAX_SET ? "Top " + MAX_SET + " of " + set.length : "All " + set.length) + ' products tagged "' + labelOf(tag) + '"' + (sameCat ? " · same category (" + pick[0].cat + ")" : ""),
      });
    }

    // 2. Nearest neighbours of each product.
    const sim = (a: BundleProduct, b: BundleProduct) => {
      const bt = new Set(tagsOf(b));
      let s = 0;
      const shared: string[] = [];
      for (const t of tagsOf(a)) if (bt.has(t)) { s += tagWeight(t); shared.push(t); }
      const bk = new Set(keywordsOf(b.title));
      for (const k of keywordsOf(a.title)) if (bk.has(k) && (kwDf.get(k)?.length ?? 0) <= 8) s += 45;
      if (a.cat && a.cat === b.cat) s += 30;
      return { s, shared };
    };
    for (const seed of list) {
      const near = list.filter((p) => p !== seed)
        .map((p) => ({ p, ...sim(seed, p) }))
        .filter((x) => x.s >= 100)
        .sort((a, b) => b.s - a.s || popularityScore(b.p) - popularityScore(a.p))
        .slice(0, MAX_SET - 1);
      if (!near.length) continue;
      const set = [seed, ...near.map((x) => x.p)];
      const sharedAll = near[0].shared;
      const avg = near.reduce((sum, x) => sum + x.s, 0) / near.length;
      cands.push({
        set, kind: "near", seedTitle: seed.title, label: sharedAll.length ? labelOf(sharedAll[0]) : (seed.cat || "Starter"),
        score: 100 + Math.min(40, avg / 4) + set.length * 4 + Math.min(20, popularityScore(seed) / 50),
        reason: "Closest matches to " + seed.title + (sharedAll.length ? " (" + sharedAll.map(labelOf).join(", ") + ")" : ""),
      });
    }

    // 3. Rare title words.
    for (const [kw, set] of kwDf) {
      if (set.length < 2 || set.length > 8) continue;
      const pick = top(set, MAX_SET);
      const sameCat = pick.every((p) => p.cat === pick[0].cat);
      cands.push({
        set: pick, kind: "kw", label: kw.charAt(0).toUpperCase() + kw.slice(1),
        score: 90 + (sameCat ? 30 : 0) + pick.length * 3,
        reason: 'Shared keyword "' + kw.charAt(0).toUpperCase() + kw.slice(1) + '"' + (sameCat ? " · same category (" + pick[0].cat + ")" : ""),
      });
    }

    // 4. Subcategory / category fallbacks (weakest).
    const catMap = new Map<string, BundleProduct[]>();
    for (const p of list) if (p.cat) { if (!catMap.has(p.cat)) catMap.set(p.cat, []); catMap.get(p.cat)!.push(p); }
    for (const [cat, set] of catMap) {
      if (set.length < 2) continue;
      const pick = top(set, 4);
      cands.push({ set: pick, kind: "cat", label: cat, score: 55 + pick.length * 2, reason: "Best sellers in " + cat });
    }
  }

  // De-duplicate (keep the higher score) and drop anything a live bundle already covers.
  const existingSets = existing.map((b) => new Set(b.slugs));
  cands.sort((a, b) => b.score - a.score);
  const kept: Cand[] = [];
  for (const c of cands) {
    const slugs = c.set.map((p) => p.slug);
    if (new Set(slugs).size < 2) continue;
    if (existingSets.some((e) => slugs.every((sl) => e.has(sl)))) continue;
    const dup = kept.some((k) => {
      const ks = new Set(k.set.map((p) => p.slug));
      const inter = slugs.filter((sl) => ks.has(sl)).length;
      return inter / new Set([...slugs, ...ks]).size > 0.6;
    });
    if (!dup) kept.push(c);
  }

  let blocked = 0;
  const suggestions: BundleSuggestion[] = [];
  for (const c of kept) {
    const lim = bundleMaxPct(c.set);
    // Never suggest what cannot be discounted without breaching a floor.
    if (lim.maxPct < BUNDLE_MIN_PCT) { blocked++; continue; }
    const n = c.set.length;
    const suggestedPct = Math.max(BUNDLE_MIN_PCT, Math.min(lim.maxPct, 10 + 5 * (n - 2), 25));
    const listUsd = round2(c.set.reduce((sum, p) => sum + Number(p.price_usd), 0));
    const bundleUsd = round2(c.set.reduce((sum, p) => sum + round2(Number(p.price_usd) * (1 - suggestedPct / 100)), 0));

    const L = c.label;
    const plural = /s$/i.test(L); // "VFX Packs" reads as a collection already
    let titles: string[]; let descs: string[];
    if (c.kind === "cat") {
      titles = [`${L} Bundle`, `${L} Starter Pack`, `The ${L} Collection`];
      descs = [`A set of our best ${L} products for a discount!`, `Everything you need for ${L}, bundled and discounted.`];
    } else if (c.kind === "near" && c.seedTitle) {
      titles = [`${c.seedTitle} Bundle`, `More Like ${c.seedTitle}`, `${L} Starter Bundle`];
      descs = [`${c.seedTitle} and the products that go best with it, for a discount!`, `Buy ${c.seedTitle} with its closest matches and save.`];
    } else {
      titles = [`${L}${/bundle$/i.test(L) ? "" : " Bundle"}`, `The Complete ${L} Collection`, `${L} Starter Bundle`];
      descs = [
        `All of our ${L}${plural ? "" : " products"} for a discount!`,
        `Everything ${L} in one bundle - buy together and save.`,
      ];
    }
    suggestions.push({
      slugs: c.set.map((p) => p.slug),
      coverSlug: pickCoverSlug(c.set),
      reason: c.reason,
      score: Math.round(c.score),
      maxPct: lim.maxPct,
      suggestedPct,
      listUsd,
      bundleUsd,
      titleOptions: titles,
      descriptionOptions: descs,
    });
  }
  suggestions.sort((a, b) => b.score - a.score);
  return { suggestions: suggestions.slice(0, 12), blocked };
}
