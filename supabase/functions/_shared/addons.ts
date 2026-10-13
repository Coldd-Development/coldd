// supabase/functions/_shared/addons.ts
//
// Per-product add-ons (Setup Service, Thumbnail Access, ...). Shared by all
// four checkout functions (Stripe / PayPal / crypto / Robux) so an add-on is
// priced, validated and recorded identically whichever way the buyer pays.
//
// Add-ons are deliberately kept OUT of every discount path. They are added to
// an order after the product lines have been priced and discounted
// (coupons, sale events, spend tiers, bundles), so none of that math - or any
// product_legal floor - ever has to know they exist, and a service the team
// performs by hand is never marked down by a sale.
//
// The client only ever sends add-on IDs per cart line; the price, the title
// and whether the add-on belongs to that product at all are all re-read from
// the database here.

// Same constants and rounding the admin product form uses for a product's
// own Robux price (admin.js devexRobuxPrice): the raw DevEx figure rounded UP
// to a clean hundred, since nobody prices a listing at a number like 1316.
export const ADDON_DEVEX_USD_PER_ROBUX = 0.0038;

export function devexRobux(usd: number): number {
  return Math.ceil(Number(usd) / ADDON_DEVEX_USD_PER_ROBUX / 100) * 100;
}

// An explicit Robux price wins; otherwise derive it from the USD price. `> 0`
// (not `!= null`) so a stray 0 falls back to the estimate rather than selling
// for free.
export function addonRobuxPrice(addon: { price_usd: number | string; price_robux?: number | string | null }): number {
  return Number(addon.price_robux) > 0 ? Math.round(Number(addon.price_robux)) : devexRobux(Number(addon.price_usd));
}

// Anything with "setup" in its title is hands-on work: the buyer has to open
// a ticket in the Discord before the team can start. Decided from the title
// so a new add-on needs no extra flag.
export function needsTicket(title: string): boolean {
  return /setup/i.test(String(title || ""));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ADDONS_PER_LINE = 10;
const MAX_ADDONS_PER_ORDER = 30;

export type PricedAddon = {
  addonId: string;
  productId: string;
  productSlug: string;
  productTitle: string;
  title: string;
  description: string;
  unitUsd: number;
  unitRobux: number;
  needsTicket: boolean;
  storagePath: string | null;
  fileName: string | null;
  // Whether this add-on may be paid for in Robux (Roblox product, Robux pricing on).
  robuxOk: boolean;
};

export type AddonPricing =
  | { ok: true; addons: PricedAddon[]; totalUsd: number; totalRobux: number }
  | { ok: false; error: string };

const NONE: AddonPricing = { ok: true, addons: [], totalUsd: 0, totalRobux: 0 };

// items: the same cart lines the caller already priced; each may carry
// `addons: string[]` (add-on UUIDs for that line's product). A product that
// is in the cart twice (standard + resell licence) can only take each add-on
// once, so the same add-on can never be charged twice for one product.
// An item may carry `addonOnly: true`: the buyer already owns the product and is buying just its
// add-ons (from the dashboard or an owned product page). Those need a signed-in buyer who really
// owns the product, can't be gifted, and can't re-buy an add-on they already have.
// deno-lint-ignore no-explicit-any
export async function priceAddons(admin: any, items: any[], opts: { userId?: string | null; gift?: boolean } = {}): Promise<AddonPricing> {
  const wanted: { slug: string; id: string; only: boolean }[] = [];
  const seen = new Set<string>();
  for (const it of Array.isArray(items) ? items : []) {
    const raw = Array.isArray(it?.addons) ? it.addons : [];
    if (!raw.length) continue;
    const slug = String(it?.slug || "");
    if (raw.length > MAX_ADDONS_PER_LINE) return { ok: false, error: "Too many add-ons on one item." };
    for (const r of raw) {
      const id = String(r || "");
      if (!UUID_RE.test(id)) return { ok: false, error: "An add-on you selected is no longer available." };
      const key = slug + "|" + id;
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push({ slug, id, only: !!it?.addonOnly });
    }
  }
  if (!wanted.length) return NONE;
  if (wanted.length > MAX_ADDONS_PER_ORDER) return { ok: false, error: "Too many add-ons in one order." };

  const { data, error } = await admin
    .from("product_addons")
    .select("id, product_id, title, description, price_usd, price_robux, storage_path, file_name, active, products!inner(slug, title, is_active, platform, robux_disabled)")
    .in("id", wanted.map((w) => w.id));
  if (error) {
    console.error("[addons] could not load add-ons:", error);
    return { ok: false, error: "Add-ons are unavailable right now. Please remove them and try again." };
  }
  // deno-lint-ignore no-explicit-any
  const byId = new Map((data ?? []).map((a: any) => [a.id, a]));

  // Add-ons-only lines: the buyer must own the product and not already own the add-on.
  const onlyWanted = wanted.filter((w) => w.only);
  if (onlyWanted.length) {
    if (!opts.userId) return { ok: false, error: "Sign in to buy add-ons for a product you own." };
    if (opts.gift) return { ok: false, error: "Add-ons for a product you own can't be sent as a gift." };
    for (const slug of new Set(onlyWanted.map((w) => w.slug))) {
      const { data: own } = await admin
        .from("order_items")
        .select("id, orders!inner(user_id, status)")
        .eq("product_slug", slug)
        .eq("orders.user_id", opts.userId)
        .eq("orders.status", "paid")
        .limit(1);
      if (!own || !own.length) return { ok: false, error: "You can only buy add-ons for products you own." };
    }
    const { data: had } = await admin
      .from("order_addons")
      .select("addon_id, orders!inner(user_id, status)")
      .in("addon_id", onlyWanted.map((w) => w.id))
      .eq("orders.user_id", opts.userId)
      .eq("orders.status", "paid");
    if (had && had.length) return { ok: false, error: "You already own one of those add-ons." };
  }

  const addons: PricedAddon[] = [];
  for (const w of wanted) {
    // deno-lint-ignore no-explicit-any
    const a: any = byId.get(w.id);
    const prod = a ? (Array.isArray(a.products) ? a.products[0] : a.products) : null;
    // The add-on must exist, be live, and belong to THIS cart line's product -
    // otherwise a tampered request could attach a cheap add-on to anything.
    if (!a || !a.active || !prod || !prod.is_active || prod.slug !== w.slug) {
      return { ok: false, error: "An add-on you selected is no longer available." };
    }
    const unitUsd = Math.round(Number(a.price_usd) * 100) / 100;
    if (!(unitUsd > 0)) return { ok: false, error: "An add-on you selected is no longer available." };
    addons.push({
      addonId: a.id,
      productId: a.product_id,
      productSlug: prod.slug,
      productTitle: prod.title,
      title: String(a.title),
      description: String(a.description || ""),
      unitUsd,
      unitRobux: addonRobuxPrice(a),
      needsTicket: needsTicket(a.title),
      storagePath: a.storage_path ?? null,
      fileName: a.file_name ?? null,
      robuxOk: prod.platform === "Roblox" && !prod.robux_disabled,
    });
  }

  const totalUsd = Math.round(addons.reduce((s, a) => s + a.unitUsd, 0) * 100) / 100;
  const totalRobux = addons.reduce((s, a) => s + a.unitRobux, 0);
  return { ok: true, addons, totalUsd, totalRobux };
}

// Writes the order_addons rows. Returns false on failure so each caller can
// cancel the pending order exactly as it already does when order_items fail.
// deno-lint-ignore no-explicit-any
export async function insertOrderAddons(admin: any, orderId: string, addons: PricedAddon[]): Promise<boolean> {
  if (!addons.length) return true;
  const { error } = await admin.from("order_addons").insert(
    addons.map((a) => ({
      order_id: orderId,
      product_id: a.productId,
      product_slug: a.productSlug,
      addon_id: a.addonId,
      title: a.title,
      description: a.description,
      unit_price_usd: a.unitUsd,
      unit_price_robux: a.unitRobux,
      needs_ticket: a.needsTicket,
      storage_path: a.storagePath,
      file_name: a.fileName,
    })),
  );
  if (error) console.error("[addons] could not record order add-ons:", error);
  return !error;
}

// The line label shown on Stripe / receipts: "Setup Service - Frostline Survival Kit".
export function addonLineName(a: { title: string; productTitle: string }): string {
  return `${a.title} - ${a.productTitle}`;
}
