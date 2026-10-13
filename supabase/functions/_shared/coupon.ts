// supabase/functions/_shared/coupon.ts
//
// The single place every discount in the system is computed and every
// product_legal limit is enforced. Shared by validate-coupon and all four
// checkout functions (Stripe / PayPal / crypto / Robux) so the amount
// shown to the shopper before payment always matches what's charged.
//
// product_legal limits, enforced by every path here:
//   min_sale_usd / min_sale_robux  - absolute price floor
//   max_discount_pct               - cap on the discount PERCENTAGE
//   disallow_sales                 - no discount at all, ever
//   can_be_free                    - if false, the price may not reach $0
// They collapse into one number per line - floorUsd / floorRobux - that
// every discount path clamps against, so no caller has to know the rules.

import { type RobuxPricedLine } from "./roblox.ts";

// If can_be_free is false and nothing else sets a floor, the price may
// still be discounted but never all the way to zero.
const NONFREE_MIN_USD = 0.01;
const NONFREE_MIN_ROBUX = 1;

export const RESELL_MULT = 3; // must match app.js's RESELL_MULT and create-checkout-session's

export const CROSS_SELL_PCT = 10; // must match app.js's checkout cross-sell offer text

export type CartItem = { slug: string; qty: number; licence?: string; crossSell?: boolean };

export type PricedLine = {
  slug: string;
  title: string;
  unitPrice: number;
  qty: number;
  licence: string;
  platform: string;
  cat: string | null;
  productId: string;
  // Legal limits for this product, from product_legal (all default open for
  // a product with no row - same as every other reader of that table):
  //   minSaleUsd     - absolute price floor (product_legal.min_sale_usd)
  //   maxDiscountPct  - cap on the discount % off baseUnitPrice (0 = none)
  //   disallowSales   - barred from any discount at all
  //   floorUsd        - the effective per-unit price floor every discount
  //                     path below clamps to: the higher of minSaleUsd and
  //                     the price maxDiscountPct implies. Precomputed here
  //                     so callers never re-derive it (and never disagree).
  minSaleUsd: number;
  maxDiscountPct: number;
  disallowSales: boolean;
  canBeFree: boolean;
  floorUsd: number;
  // The licence-adjusted list price before any line-level deal, and the
  // bundle percentage that was actually applied to this line (0 = none).
  // The Robux checkout reads bundlePct to give the same bundle discount on
  // the line's Robux price.
  baseUnitPrice: number;
  bundlePct: number;
};

export async function priceItems(
  admin: any,
  items: CartItem[],
  opts?: { bundleToken?: string },
): Promise<{ ok: true; lines: PricedLine[]; subtotal: number } | { ok: false; error: string }> {
  if (!items.length) return { ok: false, error: "Your cart is empty." };
  if (items.length > 50) return { ok: false, error: "Too many items in one order." };

  const slugs = Array.from(new Set(items.map((i) => String(i.slug || ""))));
  const { data: products, error } = await admin
    .from("products")
    .select("id, slug, title, price_usd, resell_available, platform, cat, product_legal(min_sale_usd, disallow_sales, max_discount_pct, can_be_free)")
    .in("slug", slugs)
    .eq("is_active", true);
  if (error) return { ok: false, error: "Could not load products." };

  // A bundle deal ("Build more for less" on the success page, or a
  // wishlist reminder email) is a hand-picked list of slugs at their own
  // item_pct, plus bundle_pct MORE off those same lines if every slug in
  // the deal is actually present in this cart - not just some of them.
  // Expired/unknown tokens are silently ignored (same "quietly doesn't
  // apply" rule a stale coupon code gets) rather than failing checkout.
  let bundle: { slugs: string[]; item_pct: number; bundle_pct: number } | null = null;
  if (opts?.bundleToken) {
    const { data: row } = await admin
      .from("bundle_deals")
      .select("slugs, item_pct, bundle_pct, expires_at")
      .eq("token", opts.bundleToken)
      .maybeSingle();
    if (row && (!row.expires_at || new Date(row.expires_at) > new Date())) {
      bundle = row;
    }
  }
  const bundleFullySatisfied = bundle ? bundle.slugs.every((s) => slugs.includes(s)) : false;

  // Curated bundles (admin Sales & Discounts > Bundles) apply by themselves:
  // when EVERY product in a live bundle is in the cart, each of its products
  // takes the bundle's percentage - no token, no code. A product in several
  // bundles takes the best one. Membership counts any licence, but the
  // discount itself only ever lands on standard-licence lines (see below).
  // Only worth a query when the cart could possibly complete a bundle.
  const curatedPctBySlug = new Map<string, number>();
  if (slugs.length >= 2) {
    const { data: curated } = await admin
      .from("bundle_deals")
      .select("slugs, bundle_pct")
      .eq("source", "curated")
      .eq("active", true);
    for (const b of (curated ?? []) as { slugs: string[]; bundle_pct: number }[]) {
      if (!Array.isArray(b.slugs) || b.slugs.length < 2) continue;
      if (!b.slugs.every((s) => slugs.includes(s))) continue;
      const pct = Number(b.bundle_pct) || 0;
      for (const s of b.slugs) if (pct > (curatedPctBySlug.get(s) || 0)) curatedPctBySlug.set(s, pct);
    }
  }

  const bySlug = new Map((products ?? []).map((p: any) => [p.slug, p]));
  const lines: PricedLine[] = [];
  for (const raw of items) {
    const slug = String(raw.slug || "");
    const qty = Math.max(1, Math.min(20, Math.floor(Number(raw.qty) || 1)));
    const licence = raw.licence === "resell" ? "resell" : "standard";
    const product = bySlug.get(slug);
    if (!product) return { ok: false, error: `"${slug}" is no longer available.` };
    if (licence === "resell" && !product.resell_available) {
      return { ok: false, error: `${product.title} doesn't offer a resell licence.` };
    }
    const baseUnitPrice = licence === "resell" ? Math.round(product.price_usd * RESELL_MULT) : Number(product.price_usd);
    const legalRaw = Array.isArray(product.product_legal) ? product.product_legal[0] : product.product_legal;
    const minSaleUsd = Number(legalRaw?.min_sale_usd) || 0;
    const disallowSales = !!legalRaw?.disallow_sales;
    const canBeFree = !!legalRaw?.can_be_free;
    const maxDiscountPct = Math.max(0, Math.min(100, Number(legalRaw?.max_discount_pct) || 0));
    // The lowest this unit may ever be sold for. Every discount path clamps
    // to this one number, so all four product_legal limits are enforced
    // together without any caller knowing about any of them:
    //   - min_sale_usd: the contractual dollar floor
    //   - max_discount_pct: the price that % off the (licence-adjusted) base reaches
    //   - can_be_free = false: may be discounted, but not to exactly $0
    // (disallow_sales is handled separately - those lines are dropped from
    // every headroom sum, so they never take any discount at all.)
    const pctFloorUsd = maxDiscountPct > 0
      ? Math.round(baseUnitPrice * (1 - maxDiscountPct / 100) * 100) / 100
      : 0;
    const floorUsd = Math.max(minSaleUsd, pctFloorUsd, canBeFree ? 0 : NONFREE_MIN_USD);
    // The checkout cross-sell upsell ("people also get this") bakes its
    // discount straight into the line price rather than the order-level
    // discount_usd a coupon/marketing-optin uses - it's a special price on
    // a specific item being added right now, not a reduction applied
    // across the whole order. Same floor rule as every other discount
    // path: never below floorUsd (min_sale_usd or the max_discount_pct
    // cap), and disallow_sales means no discount at all (the item can
    // still be added, just at full price).
    let unitPrice = baseUnitPrice;
    let isCrossSellDeal = false;
    if (raw.crossSell && !disallowSales) {
      const discounted = Math.round(baseUnitPrice * (1 - CROSS_SELL_PCT / 100) * 100) / 100;
      const floored = floorUsd > 0 ? Math.max(discounted, floorUsd) : discounted;
      if (floored < baseUnitPrice) { unitPrice = floored; isCrossSellDeal = true; }
    }
    let bundlePctApplied = 0;
    let bundleFromCurated = false;
    const tokenPct = bundle && bundle.slugs.includes(slug)
      ? bundle.item_pct + (bundleFullySatisfied ? bundle.bundle_pct : 0)
      : 0;
    const curatedPct = curatedPctBySlug.get(slug) || 0;
    if ((tokenPct > 0 || curatedPct > 0) && !disallowSales && licence !== "resell") {
      const pct = Math.max(tokenPct, curatedPct);
      bundleFromCurated = curatedPct >= tokenPct;
      const discounted = Math.round(baseUnitPrice * (1 - pct / 100) * 100) / 100;
      const floored = floorUsd > 0 ? Math.max(discounted, floorUsd) : discounted;
      if (floored < unitPrice) { unitPrice = floored; bundlePctApplied = pct; }
    }
    lines.push({
      slug,
      title: product.title + (licence === "resell" ? " (Resell licence)" : "")
        + (isCrossSellDeal ? ` (${CROSS_SELL_PCT}% off)` : "")
        + (bundlePctApplied ? (bundleFromCurated ? ` (Bundle ${bundlePctApplied}% off)` : ` (${bundlePctApplied}% off)`) : ""),
      unitPrice,
      qty,
      licence,
      platform: product.platform,
      cat: product.cat,
      productId: product.id,
      minSaleUsd,
      maxDiscountPct,
      disallowSales,
      canBeFree,
      floorUsd,
      baseUnitPrice,
      bundlePct: bundlePctApplied,
    });
  }

  const subtotal = lines.reduce((sum, li) => sum + li.unitPrice * li.qty, 0);
  return { ok: true, lines, subtotal };
}

// Total dollars every line in `lines` could legally give up before any one
// of them hits its own floorUsd (the min_sale_usd dollar floor or the
// max_discount_pct cap, whichever is tighter) - shared by every discount
// path below (coupons, the marketing opt-in discount, the checkout
// cross-sell upsell) so they all answer "how far can this go" the same
// way. disallow_sales lines contribute zero, same as everywhere else that
// field is read.
export function legalHeadroom(lines: PricedLine[]): number {
  return lines
    .filter((li) => !li.disallowSales)
    .reduce((sum, li) => sum + Math.max(0, li.unitPrice - li.floorUsd) * li.qty, 0);
}

// A flat percentage off, used by the checkout "get 10% off" marketing
// opt-in and the genre cross-sell upsell - same floor-respecting cap as a
// coupon, just without a code to look up.
export function flatPctDiscount(lines: PricedLine[], pct: number): { discount: number; capped: boolean } {
  const eligible = lines.filter((li) => !li.disallowSales);
  const eligibleSubtotal = eligible.reduce((sum, li) => sum + li.unitPrice * li.qty, 0);
  const raw = eligibleSubtotal * (pct / 100);
  const headroom = legalHeadroom(lines);
  const cap = Math.round(Math.min(raw, headroom) * 100) / 100;
  const discount = Math.max(0, cap);
  return { discount, capped: discount < Math.round(raw * 100) / 100 };
}

// Automatic "spend $X, get Y% off" tiers - no code needed, applies itself
// off the cart's real subtotal. Ordered highest threshold first so the
// loop below can just take the first (best) tier the cart actually
// clears. Tuned for a catalog full of individually cheap products: the
// point is pulling someone from "one $15 item" toward "a cart worth
// clearing the next tier", not rewarding a cart that was already going
// to be big regardless.
// Robux thresholds are set explicitly, NOT usd * ROBUX_PER_USD - Robux
// prices run richer than the flat 80:1 estimate (a product's admin-set
// robux_price is deliberately higher), so each tier gets its own Robux
// gate tuned to real cart sizes in Robux mode.
export const SPEND_TIERS: { minSubtotal: number; minRobux: number; pct: number }[] = [
  { minSubtotal: 200, minRobux: 50000, pct: 50 },
  { minSubtotal: 100, minRobux: 26000, pct: 40 },
  { minSubtotal: 75, minRobux: 20000, pct: 30 },
  { minSubtotal: 50, minRobux: 13000, pct: 20 },
  { minSubtotal: 30, minRobux: 8000, pct: 10 },
];

// Robux equivalent of legalHeadroom(): total Robux every line could give
// up before any one hits its floorRobux (min_sale_robux, the
// max_discount_pct cap in Robux terms, or the "not free" $0 guard).
// disallow_sales lines contribute zero, same as the USD side. The Robux
// discount paths below (coupon conversion + spend tier) are aggregate, not
// per-line, so this is an aggregate backstop - the tightest guarantee the
// proportional Robux model can give without pricing every line in Robux.
export function robuxLegalHeadroom(lines: RobuxPricedLine[]): number {
  return lines
    .filter((li) => !li.disallowSales)
    .reduce((sum, li) => sum + Math.max(0, li.unitRobux - li.floorRobux) * li.qty, 0);
}

// Robux orders can't reuse spendTierDiscount() as-is: that compares a
// line list's own USD subtotal against SPEND_TIERS, but a product's real
// admin-set robux_price often has no fixed ratio to its USD price (see
// priceRobuxItems' own comment on this) - a cart that's genuinely small
// in Robux terms could still cross a USD threshold through one product
// priced disproportionately cheap in Robux, unlocking a discount that
// looks like it came from nowhere against the number actually on
// screen. This evaluates AND grants the discount against the real Robux
// total instead, gated on each tier's own explicit minRobux (see
// SPEND_TIERS) rather than a converted USD figure - so the ladder, the
// discount, and the visible total can never disagree with each other in
// Robux mode, regardless of how any one product's cross-currency pricing
// happens to sit. `headroomRobux` caps the grant so it can never push a
// line past its product_legal floor.
export function spendTierDiscountRobux(
  totalRobux: number,
  headroomRobux = Infinity,
): { discountRobux: number; pct: number; minRobux: number } {
  for (const tier of SPEND_TIERS) {
    if (totalRobux >= tier.minRobux) {
      const raw = Math.round(totalRobux * (tier.pct / 100));
      return { discountRobux: Math.max(0, Math.min(raw, headroomRobux)), pct: tier.pct, minRobux: tier.minRobux };
    }
  }
  return { discountRobux: 0, pct: 0, minRobux: 0 };
}

// Robux equivalent of clampCombinedDiscount(): a coupon discount plus a
// sale-event discount plus a spend-tier discount, each individually
// floor-safe, re-clamped together so their sum can't overshoot the
// aggregate Robux headroom (or turn the order negative).
export function clampCombinedDiscountRobux(lines: RobuxPricedLine[], totalRawRobuxDiscount: number): number {
  const headroom = robuxLegalHeadroom(lines);
  const totalRobux = lines.reduce((sum, li) => sum + li.unitRobux * li.qty, 0);
  return Math.max(0, Math.round(Math.min(totalRawRobuxDiscount, headroom, totalRobux)));
}

export function spendTierDiscount(lines: PricedLine[]): { discount: number; pct: number; minSubtotal: number } {
  const subtotal = lines.reduce((sum, li) => sum + li.unitPrice * li.qty, 0);
  for (const tier of SPEND_TIERS) {
    if (subtotal >= tier.minSubtotal) {
      const r = flatPctDiscount(lines, tier.pct);
      return { discount: r.discount, pct: tier.pct, minSubtotal: tier.minSubtotal };
    }
  }
  return { discount: 0, pct: 0, minSubtotal: 0 };
}

// Re-clamps the whole discount stack together - coupon + sale event +
// spend tier - since each is independently capped against the SAME
// headroom. Stacked without this, their sum could still legally overshoot
// a floor (or zero the order) even though no single one did.
export function clampCombinedDiscount(lines: PricedLine[], totalRawDiscount: number): number {
  const headroom = legalHeadroom(lines);
  const subtotal = lines.reduce((sum, li) => sum + li.unitPrice * li.qty, 0);
  return Math.round(Math.max(0, Math.min(totalRawDiscount, headroom, subtotal)) * 100) / 100;
}

export type CouponResolution =
  | { ok: true; code: string; discount: number; scopedSubtotal: number; note?: string }
  | { ok: false; error: string };

// Resolves a coupon against an already-priced cart. discount is in whole
// dollars (matches subtotal_usd/discount_usd's numeric(10,2) columns) -
// callers going to Stripe convert to cents themselves.
//
// Every discount path in this file - coupons here, the checkout cross-sell
// upsell, the marketing-signup code - has to respect product_legal's
// limits: min_sale_usd (the dollar floor the underlying license/reseller
// agreement sets), max_discount_pct (the cap on how big a % discount may
// be), and disallow_sales (no discount at all, ever). A coupon is never scoped
// to just the products it can legally discount, so rather than reject the
// whole code the moment ANY line in scope can't take the full discount,
// this caps the total to whatever every eligible line can still legally
// absorb and says so in `note` - the code still does something, it just
// doesn't pretend a product can go below a price it's contractually not
// allowed to.
export async function resolveCoupon(admin: any, rawCode: string, lines: PricedLine[]): Promise<CouponResolution> {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: false, error: "Enter a code." };

  const { data: coupon, error } = await admin.from("coupons").select("*").eq("code", code).maybeSingle();
  if (error) return { ok: false, error: "Could not check that code." };
  if (!coupon || !coupon.active) return { ok: false, error: "That code is invalid or no longer active." };
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return { ok: false, error: "That code has expired." };
  }
  if (coupon.usage_limit != null && coupon.usage_count >= coupon.usage_limit) {
    return { ok: false, error: "That code has reached its usage limit." };
  }

  const matches = (li: PricedLine) => {
    if (coupon.scope === "platform") return li.platform === coupon.platform;
    if (coupon.scope === "category") return li.platform === coupon.platform && li.cat === coupon.category;
    return true; // sitewide
  };
  const scopedLines = lines.filter(matches);
  const scopedSubtotal = scopedLines.reduce((sum, li) => sum + li.unitPrice * li.qty, 0);
  if (scopedSubtotal <= 0) {
    return { ok: false, error: "That code doesn't apply to anything in your cart." };
  }

  // disallow_sales lines take zero discount and don't count toward scope at
  // all (matches admin-weekly-deals treating them as fully off-limits, not
  // just capped) - a code can still apply to the rest of the cart around
  // them.
  const eligibleLines = scopedLines.filter((li) => !li.disallowSales);
  const eligibleSubtotal = eligibleLines.reduce((sum, li) => sum + li.unitPrice * li.qty, 0);
  if (eligibleSubtotal <= 0) {
    return { ok: false, error: "That code doesn't apply to anything discountable in your cart." };
  }
  // How much every eligible (in-scope) line could give up in total before
  // any single one hits its own floorUsd (min_sale_usd or the
  // max_discount_pct cap) - a line with neither set can absorb its whole
  // price, same as before this check existed. Scoped to just this coupon's
  // matching lines, not legalHeadroom(lines) above (that one's sitewide,
  // for the marketing-optin discount).
  const couponHeadroom = eligibleLines.reduce((sum, li) => sum + Math.max(0, li.unitPrice - li.floorUsd) * li.qty, 0);

  const raw = coupon.type === "pct" ? scopedSubtotal * (Number(coupon.val) / 100) : Number(coupon.val);
  const cap = Math.min(scopedSubtotal, eligibleSubtotal, couponHeadroom);
  const discount = Math.round(Math.max(0, Math.min(raw, cap)) * 100) / 100;
  const wasCapped = discount < Math.round(Math.min(raw, scopedSubtotal) * 100) / 100;
  return {
    ok: true,
    code: coupon.code,
    discount,
    scopedSubtotal,
    note: wasCapped ? "Applied at the largest discount your cart currently qualifies for." : undefined,
  };
}

// ---- Sale events ---------------------------------------------------------
//
// A store-wide (or platform / category-scoped) percentage sale set up in
// the admin Sales tab. It lives in `content` as type 'sale_event' with
// { percentOff, scope, platform, category, startDate, endDate }, is shown
// in the announcement bar by app.js, and - via the two helpers here -
// applies automatically at checkout: effectively an automatic sitewide
// coupon with no code. It stacks with a real coupon and the spend tiers,
// and the whole stack is re-clamped by clampCombinedDiscount so no
// product_legal floor is ever breached.

export type SaleEvent = {
  slug: string;
  pct: number;
  scope: "sitewide" | "platform" | "category";
  platform: string | null;
  category: string | null;
};

// The one live sale event (first match if several overlap), or null.
// Dates are plain YYYY-MM-DD and inclusive on both ends, matching
// catalog.js's pickActiveSale so the bar and the checkout agree.
export async function activeSaleEvent(admin: any): Promise<SaleEvent | null> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await admin
    .from("content")
    .select("slug, data")
    .eq("type", "sale_event")
    .eq("visible", true)
    .order("created_at", { ascending: false });
  if (error || !Array.isArray(data)) return null;
  for (const row of data) {
    const d = (row as any).data || {};
    if (!d.startDate || !d.endDate) continue;
    if (today < String(d.startDate) || today > String(d.endDate)) continue;
    // percentOff is only clamped client-side (admin.js) today; re-clamp
    // here so this path is authoritative on its own.
    const pct = Math.max(0, Math.min(90, Math.round(Number(d.percentOff) || 0)));
    if (pct <= 0) continue;
    const scope = d.scope === "platform" || d.scope === "category" ? d.scope : "sitewide";
    return { slug: String((row as any).slug || ""), pct, scope, platform: d.platform || null, category: d.category || null };
  }
  return null;
}

// The sale event's dollar discount for this cart - the scoped % off,
// capped by the legal headroom of just the lines the sale covers. Zero if
// there's no sale or nothing in scope.
export function saleEventDiscount(lines: PricedLine[], sale: SaleEvent | null): { discount: number; pct: number } {
  if (!sale || sale.pct <= 0) return { discount: 0, pct: 0 };
  const inScope = (li: PricedLine) => {
    if (sale.scope === "platform") return li.platform === sale.platform;
    if (sale.scope === "category") return li.platform === sale.platform && li.cat === sale.category;
    return true;
  };
  const scoped = lines.filter(inScope);
  if (!scoped.length) return { discount: 0, pct: 0 };
  return { discount: flatPctDiscount(scoped, sale.pct).discount, pct: sale.pct };
}
