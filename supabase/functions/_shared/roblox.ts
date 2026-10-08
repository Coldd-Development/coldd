// supabase/functions/_shared/roblox.ts
//
// Thin client for Roblox's Game Passes Open Cloud API (beta), shared
// between admin-upsert-product and admin-delete-product. Schema
// confirmed against Roblox's published OpenAPI spec (Roblox/creator-docs
// on GitHub, content/en-us/reference/cloud/game-passes-http-service/
// v1.json) rather than guessed - requests are multipart/form-data, not
// JSON, and price is a plain integer (whole Robux, no decimals).

const ROBLOX_API_BASE = "https://apis.roblox.com/game-passes/v1";

function apiKey() {
  return Deno.env.get("ROBLOX_API_KEY")!;
}

export type GamePassConfig = {
  gamePassId: number;
  name: string;
  description: string;
  isForSale: boolean;
  iconAssetId: number;
  priceInformation?: { defaultPriceInRobux?: number | null };
};

export async function createGamepass(
  universeId: string,
  opts: { name: string; description?: string; price: number }
): Promise<GamePassConfig> {
  const form = new FormData();
  form.set("name", opts.name.slice(0, 50));
  if (opts.description) form.set("description", opts.description.slice(0, 1000));
  form.set("isForSale", "true");
  form.set("price", String(Math.max(0, Math.round(opts.price))));

  const res = await fetch(`${ROBLOX_API_BASE}/universes/${universeId}/game-passes`, {
    method: "POST",
    headers: { "x-api-key": apiKey() },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Roblox rejected game-pass create for universe ${universeId} (HTTP ${res.status}). ` +
        `The ROBLOX_API_KEY needs "game-passes" write access for THIS experience - ` +
        `add it at create.roblox.com/dashboard/credentials (the game-passes scope is per-experience), ` +
        `or the key has expired.`,
      );
    }
    throw new Error((data && data.errorMessage) || `Roblox gamepass create failed (${res.status})`);
  }
  return data as GamePassConfig;
}

export async function updateGamepass(
  universeId: string,
  gamePassId: string,
  opts: { price?: number; isForSale?: boolean; name?: string; description?: string }
): Promise<void> {
  const form = new FormData();
  if (opts.name != null) form.set("name", opts.name.slice(0, 50));
  if (opts.description != null) form.set("description", opts.description.slice(0, 1000));
  if (opts.price != null) form.set("price", String(Math.max(0, Math.round(opts.price))));
  if (opts.isForSale != null) form.set("isForSale", String(opts.isForSale));

  const res = await fetch(`${ROBLOX_API_BASE}/universes/${universeId}/game-passes/${gamePassId}`, {
    method: "PATCH",
    headers: { "x-api-key": apiKey() },
    body: form,
  });
  if (res.status === 204) return;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Roblox rejected game-pass update for universe ${universeId} (HTTP ${res.status}) - ` +
      `the ROBLOX_API_KEY is missing "game-passes" access for this experience or has expired.`,
    );
  }
  throw new Error((data && data.errorMessage) || `Roblox gamepass update failed (${res.status})`);
}

// Reads one game pass's current live state (name, price, for-sale). Used to
// confirm a pool pass hasn't been renamed or re-priced by hand before a
// buyer is pointed at it. Returns null if it can't be read (caller decides
// whether that's fatal).
export async function getGamepass(universeId: string, gamePassId: string): Promise<GamePassConfig | null> {
  try {
    const res = await fetch(
      `${ROBLOX_API_BASE}/universes/${universeId}/game-passes/${gamePassId}/creator`,
      { headers: { "x-api-key": apiKey() } },
    );
    if (!res.ok) {
      console.error("[roblox] getGamepass failed", universeId, gamePassId, res.status);
      return null;
    }
    return (await res.json()) as GamePassConfig;
  } catch (err) {
    console.error("[roblox] getGamepass error", err);
    return null;
  }
}

export type RobloxContainer = { id: string; universe_id: string; gamepass_count: number };

// Roblox's hard limit on game passes per universe.
export const GAMEPASS_HARD_CAP = 50;
// Slots kept free in every container for game passes staff create and
// manage BY HAND (a promo pass, a donation pass, whatever). The pool will
// keep leasing passes it already has right up to the cap, but it stops
// GROWING once this much headroom is left, so a manual pass never fails to
// create because auto-provisioning ate the last slot. See the "manual game
// pass" note in roblox_pool.ts.
export const MANUAL_PASS_RESERVE = 6;

// Live count of every game pass in a universe, straight from Roblox, so
// passes created by hand are counted the same as ones the pool made -
// there is no local number to keep in sync and nothing drifts. Returns
// null if the listing can't be completed (caller falls back to the stored
// gamepass_count).
export async function listGamepassCount(universeId: string): Promise<number | null> {
  try {
    let total = 0;
    let pageToken = "";
    for (let guard = 0; guard < 20; guard++) {
      const url = new URL(`${ROBLOX_API_BASE}/universes/${universeId}/game-passes/creator`);
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url.toString(), { headers: { "x-api-key": apiKey() } });
      if (!res.ok) {
        console.error("[roblox] listGamepassCount failed", universeId, res.status);
        return null;
      }
      // deno-lint-ignore no-explicit-any
      const data: any = await res.json().catch(() => ({}));
      total += Array.isArray(data.gamePasses) ? data.gamePasses.length : 0;
      pageToken = data.nextPageToken || "";
      if (!pageToken) return total;
    }
    return total; // hit the page guard - close enough for a cap check
  } catch (err) {
    console.error("[roblox] listGamepassCount error", universeId, err);
    return null;
  }
}

// Picks the oldest active container that still has room to GROW the pool
// (live pass count below the cap minus the manual reserve). Returns null
// when every container is full - callers must then hard-block rather than
// serve a wrong pass, since Roblox has no API to create a new universe.
// Also self-heals the stored gamepass_count from the live figure whenever
// it reads one, so the admin panel display stops drifting.
// deno-lint-ignore no-explicit-any
export async function pickContainer(admin: any): Promise<RobloxContainer | null> {
  const { data, error } = await admin
    .from("roblox_containers")
    .select("id, universe_id, gamepass_count")
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error || !data || !data.length) return null;

  const growCap = GAMEPASS_HARD_CAP - MANUAL_PASS_RESERVE;
  for (const c of data as RobloxContainer[]) {
    const live = await listGamepassCount(c.universe_id);
    const count = live == null ? Number(c.gamepass_count) || 0 : live;
    if (live != null && live !== Number(c.gamepass_count)) {
      await admin.from("roblox_containers").update({ gamepass_count: live }).eq("id", c.id);
    }
    if (count < growCap) return { ...c, gamepass_count: count };
  }
  return null;
}

/* ================================================================
   ROBUX CHECKOUT (create-robux-order / verify-robux-order)
   ================================================================ */

export const ROBUX_PER_USD = 80; // matches app.js's ROBUX_PER_USD/admin.js's fallback

export const RESELL_MULT = 3; // must match _shared/coupon.ts / app.js

export type RobuxCartItem = { slug: string; qty: number; licence?: string };
export type RobuxPricedLine = {
  slug: string;
  title: string;
  unitRobux: number;
  unitPriceUsd: number;
  qty: number;
  productId: string;
  licence: string;
  // product_legal limits in Robux terms, mirroring _shared/coupon.ts's
  // PricedLine. floorRobux is the lowest this unit may be sold for in
  // Robux; disallowSales lines are dropped from every Robux headroom sum.
  disallowSales: boolean;
  floorRobux: number;
};

// Robux price for one licence of a product, mirroring the standard
// licence's logic: an admin-set Robux price wins; otherwise convert the
// licence's USD price at ROBUX_PER_USD. `> 0` (not `!= null`) so a stray
// 0 in the field falls back to the estimate rather than selling for free.
// deno-lint-ignore no-explicit-any
export function robuxUnitPrice(product: any, resell: boolean): { unitRobux: number; unitPriceUsd: number } {
  if (resell) {
    // Resell USD basis matches _shared/coupon.ts priceItems (the flat 3x)
    // so the two never disagree on the same order.
    const resellUsd = Math.round(Number(product.price_usd) * RESELL_MULT);
    const unitRobux = Number(product.resell_robux_price) > 0
      ? Number(product.resell_robux_price)
      : Math.round(resellUsd * ROBUX_PER_USD);
    return { unitRobux, unitPriceUsd: resellUsd };
  }
  const unitRobux = Number(product.robux_price) > 0
    ? Number(product.robux_price)
    : Math.round(Number(product.price_usd) * ROBUX_PER_USD);
  return { unitRobux, unitPriceUsd: Number(product.price_usd) };
}

// Robux-specific pricing: only requires the product to be a Roblox item
// (not resell), and rejects resell licences - Robux pricing doesn't
// support resell anywhere else in this codebase either (see
// product.html/app.js's cart+checkout fix).
//
// This used to also require product.roblox_gamepass_id - a per-product
// gamepass, from a design where each product had its own pass to buy.
// That model was replaced by the pool (see roblox_pool.ts: one shared
// pass, leased and re-priced per order), which needs no per-product
// gamepass at all. The old field is unpopulated on nearly every product
// (only ever set on whichever product happened to get one under the old
// flow), so this gate was hard-blocking Robux checkout for almost the
// entire catalog with "isn't available for Robux checkout yet."
// deno-lint-ignore no-explicit-any
export async function priceRobuxItems(
  admin: any,
  items: RobuxCartItem[],
): Promise<{ ok: true; lines: RobuxPricedLine[]; totalRobux: number } | { ok: false; error: string }> {
  if (!items.length) return { ok: false, error: "Your cart is empty." };
  if (items.length > 20) return { ok: false, error: "Too many items in one order." };

  const slugs = Array.from(new Set(items.map((i) => String(i.slug || ""))));
  const { data: products, error } = await admin
    .from("products")
    .select("id, slug, title, price_usd, robux_price, robux_disabled, platform, resell_available, resell_robux_price, product_legal(min_sale_robux, disallow_sales, max_discount_pct, can_be_free)")
    .in("slug", slugs)
    .eq("is_active", true);
  if (error) return { ok: false, error: "Could not load products." };

  // deno-lint-ignore no-explicit-any
  const bySlug = new Map((products ?? []).map((p: any) => [p.slug, p]));
  const lines: RobuxPricedLine[] = [];
  for (const raw of items) {
    const slug = String(raw.slug || "");
    const qty = Math.max(1, Math.min(20, Math.floor(Number(raw.qty) || 1)));
    const isResell = raw.licence === "resell";
    const product = bySlug.get(slug);
    if (!product) return { ok: false, error: `"${slug}" is no longer available.` };
    if (product.robux_disabled) {
      return { ok: false, error: `${product.title} cannot be bought with Robux.` };
    }
    if (product.platform !== "Roblox") {
      return { ok: false, error: `${product.title} isn't available for Robux checkout yet.` };
    }
    if (isResell && !product.resell_available) {
      return { ok: false, error: `${product.title} doesn't offer a resell licence.` };
    }
    const { unitRobux, unitPriceUsd } = robuxUnitPrice(product, isResell);
    const legal = Array.isArray(product.product_legal) ? product.product_legal[0] : product.product_legal;
    const disallowSales = !!legal?.disallow_sales;
    const minSaleRobux = Number(legal?.min_sale_robux) || 0;
    const maxPct = Math.max(0, Math.min(100, Number(legal?.max_discount_pct) || 0));
    const canBeFree = !!legal?.can_be_free;
    // Same rule as coupon.ts's floorUsd, in Robux: the highest of the
    // min_sale_robux floor, what max_discount_pct% off this unit reaches,
    // and (unless can_be_free) a non-zero minimum.
    const pctFloorRobux = maxPct > 0 ? Math.round(unitRobux * (1 - maxPct / 100)) : 0;
    const floorRobux = Math.max(minSaleRobux, pctFloorRobux, canBeFree ? 0 : 1);
    lines.push({
      slug,
      title: product.title + (isResell ? " (Resell licence)" : ""),
      unitRobux,
      unitPriceUsd,
      qty,
      productId: product.id,
      licence: isResell ? "resell" : "standard",
      disallowSales,
      floorRobux,
    });
  }

  const totalRobux = lines.reduce((sum, li) => sum + li.unitRobux * li.qty, 0);
  return { ok: true, lines, totalRobux };
}

// The one scope Robux checkout's ownership fallback actually depends on.
// A space-separated OAuth scope string ("openid profile
// user.inventory-item:read") is checked by substring, not exact match -
// Roblox may grant scopes in any order or alongside others.
export const ROBLOX_INVENTORY_SCOPE = "user.inventory-item:read";
export function hasInventoryScope(scope: string | null | undefined): boolean {
  return !!scope && scope.split(/\s+/).includes(ROBLOX_INVENTORY_SCOPE);
}

export type RobloxTokenSet = { accessToken: string; robloxId: string };

// Loads the caller's linked Roblox account, refreshing the OAuth token if
// it's expired (Roblox access tokens are short-lived). Returns null if
// there's no link at all - callers should prompt the user to link.
// deno-lint-ignore no-explicit-any
export async function getValidRobloxToken(admin: any, userId: string): Promise<RobloxTokenSet | null> {
  const { data: acct, error } = await admin
    .from("roblox_accounts")
    .select("roblox_id, access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !acct) return null;

  const expiresAt = new Date(acct.expires_at).getTime();
  if (expiresAt > Date.now() + 60_000) {
    return { accessToken: acct.access_token, robloxId: acct.roblox_id };
  }

  const clientId = Deno.env.get("ROBLOX_OAUTH_CLIENT_ID")!;
  const clientSecret = Deno.env.get("ROBLOX_OAUTH_CLIENT_SECRET")!;
  const tokenRes = await fetch("https://apis.roblox.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: acct.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    console.error("[roblox] token refresh failed:", tokenRes.status, tokenData?.error || tokenData?.error_description || "unknown");
    return null;
  }

  const newExpiresAt = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000).toISOString();
  await admin
    .from("roblox_accounts")
    .update({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || acct.refresh_token,
      expires_at: newExpiresAt,
    })
    .eq("user_id", userId);

  return { accessToken: tokenData.access_token, robloxId: acct.roblox_id };
}

// Thrown when Roblox rejects the inventory call for auth reasons (401/403)
// rather than "not found" - most commonly a token authorized before
// user.inventory-item:read was requested (refreshing an existing token
// keeps its original scope; only a fresh /authorize round-trip grants a
// newly-added scope). Callers should tell the buyer to re-link, not
// treat this as "just wait and retry."
export class RobloxInsufficientScopeError extends Error {
  constructor(status: number) {
    super(`Roblox inventory check rejected with HTTP ${status} - likely missing the inventory scope.`);
    this.name = "RobloxInsufficientScopeError";
  }
}

// Checks which of the given gamePassIds appear in the target user's
// Roblox inventory, using their own OAuth token (requires the
// user.inventory-item:read scope, granted at link time). Filter syntax
// confirmed against Roblox's docs (create.roblox.com/docs/cloud/reference/
// patterns#list-inventory-items): semicolon-separated field=value pairs,
// gamePassIds takes a comma-separated list. Paginates defensively even
// though a single filtered request should normally fit on one page.
export async function findOwnedGamePasses(
  accessToken: string,
  robloxUserId: string,
  gamePassIds: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (!gamePassIds.length) return found;

  let pageToken: string | undefined;
  do {
    // gamePassIds already implies the game-pass type filter - Roblox's
    // docs are explicit that the type field (gamePasses=true) and an ID
    // field (gamePassIds=...) can't be combined in the same filter.
    const params = new URLSearchParams({
      filter: `gamePassIds=${gamePassIds.join(",")}`,
      maxPageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(
      `https://apis.roblox.com/cloud/v2/users/${robloxUserId}/inventory-items?${params.toString()}`,
      { headers: { Authorization: "Bearer " + accessToken } },
    );
    if (res.status === 401 || res.status === 403) {
      throw new RobloxInsufficientScopeError(res.status);
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      console.error("[roblox] inventory check failed:", res.status, bodyText);
      throw new Error(`Roblox inventory check failed (HTTP ${res.status}): ${bodyText.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    // deno-lint-ignore no-explicit-any
    (data.inventoryItems || []).forEach((item: any) => {
      const id = item.gamePassDetails && item.gamePassDetails.gamePassId;
      if (id) found.add(String(id));
    });
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);

  return found;
}

/* ================================================================
   GROUP-TRANSACTION FALLBACK (Phase D) - only runs if
   ROBLOX_FALLBACK_COOKIE is set. This is the legacy, cookie-authenticated
   economy.roblox.com API (not Open Cloud, not in the published OpenAPI
   spec the rest of this file was verified against) - its exact response
   shape could not be confirmed ahead of time without a live cookie, so
   this is best-effort and fails soft (logs + returns false) rather than
   throwing, on the assumption the primary inventory check already
   covers the common case and this is a secondary safety net.
   ================================================================ */

export function robloxFallbackConfigured(): boolean {
  return !!Deno.env.get("ROBLOX_FALLBACK_COOKIE");
}

/**
 * Pool-model verification: proves a purchase of THIS pass, at THIS price, AFTER
 * this lease began.
 *
 * Ownership is useless once passes are pooled and reused. A gamepass is owned
 * forever, so a buyer who legitimately paid for pool pass #3 last week still
 * "owns" it - and an ownership check would hand them every future order free the
 * next time that pass came round. Only a sale record carries the amount and the
 * timestamp that distinguish one purchase from another.
 *
 * All three conditions are required. Dropping any one of them reintroduces a way
 * to pay less than the order is worth, or to reuse an older purchase.
 */
export async function findPoolSale(
  gamePassId: string,
  buyerRobloxId: string,
  expectedRobux: number,
  leasedAtIso: string,
): Promise<{ found: boolean; reason?: string }> {
  const cookie = Deno.env.get("ROBLOX_FALLBACK_COOKIE");
  const groupId = Deno.env.get("ROBLOX_GROUP_ID");
  if (!cookie || !groupId) return { found: false, reason: "NOT_CONFIGURED" };

  try {
    const url = `https://economy.roblox.com/v2/groups/${groupId}/transactions?transactionType=Sale&limit=100&sortOrder=Desc`;
    const res = await fetch(url, { headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
    if (res.status === 401 || res.status === 403) {
      console.error("[roblox] sale lookup: cookie rejected", res.status);
      await notifyRobloxCookieBroken(`Pool sale lookup got HTTP ${res.status} - the cookie is likely expired.`);
      return { found: false, reason: "COOKIE_BROKEN" };
    }
    if (!res.ok) return { found: false, reason: "LOOKUP_FAILED" };

    const data = await res.json().catch(() => ({}));
    // deno-lint-ignore no-explicit-any
    const rows: any[] = data.data || [];
    const leasedAt = Date.parse(leasedAtIso);

    const match = rows.find((row) => {
      const details = row.details || {};
      const agent = row.agent || {};
      if (String(details.id) !== String(gamePassId)) return false;
      if (String(agent.id) !== String(buyerRobloxId)) return false;

      // Amount. Roblox reports the group's share, which for a group-owned pass
      // is ~70% of the price (their marketplace cut is ~30%), floored to a
      // whole Robux - confirmed against a real sale: a 5 Robux order reported
      // as exactly 3 Robux (floor(5*0.7)=3), not the >=3.25 the old 0.65
      // multiplier required. That flat percentage was never actually wrong at
      // realistic prices (thousands of Robux, where 1 Robux of rounding is
      // noise) - it silently failed every low-value order, which is
      // extremely convenient to trip during a merely 5-Robux test purchase,
      // and murder for anyone testing cheap items. -1 is slack for a second
      // rounding step Roblox may apply on their end that isn't visible here.
      const amount = Math.abs(Number(row.currency?.amount ?? NaN));
      if (!Number.isFinite(amount)) return false;
      if (amount < Math.floor(expectedRobux * 0.7) - 1) return false;

      // Time. Must postdate the lease, or an older purchase of this same pooled
      // pass would satisfy a brand-new order.
      const created = Date.parse(row.created ?? "");
      if (!Number.isFinite(created) || !Number.isFinite(leasedAt)) return false;
      // Small allowance for clock skew between Roblox and us.
      return created >= leasedAt - 120_000;
    });

    if (!match) {
      // No log access via CLI in this environment - this is the only trail
      // for diagnosing a "not found" that should have matched. Look for a
      // same-pass/same-buyer row that failed on amount or timing alone, so a
      // future read of these logs can tell "not posted yet" apart from "the
      // 0.65 tolerance or clock-skew allowance is wrong for this order."
      const nearMiss = rows.find((row) => {
        const details = row.details || {};
        const agent = row.agent || {};
        return String(details.id) === String(gamePassId) && String(agent.id) === String(buyerRobloxId);
      });
      if (nearMiss) {
        console.error(
          "[roblox] findPoolSale: same pass+buyer row exists but was rejected -",
          "amount:", nearMiss.currency?.amount, "expected:", expectedRobux, "* 0.65 =", expectedRobux * 0.65,
          "created:", nearMiss.created, "leasedAt:", leasedAtIso,
        );
      } else {
        console.error("[roblox] findPoolSale: no row at all for pass", gamePassId, "buyer", buyerRobloxId, "in last", rows.length, "sales");
      }
    }

    return { found: !!match };
  } catch (err) {
    console.error("[roblox] pool sale lookup error:", err);
    return { found: false, reason: "LOOKUP_FAILED" };
  }
}

// Checks the group's recent Sale transactions for a purchase of the given
// gamePassId by the given Roblox buyer. Returns true/false; never throws.
export async function checkGroupTransactionForSale(
  gamePassId: string,
  buyerRobloxId: string,
): Promise<boolean> {
  const cookie = Deno.env.get("ROBLOX_FALLBACK_COOKIE");
  const groupId = Deno.env.get("ROBLOX_GROUP_ID");
  if (!cookie || !groupId) return false;

  try {
    const url = `https://economy.roblox.com/v2/groups/${groupId}/transactions?transactionType=Sale&limit=100&sortOrder=Desc`;
    const res = await fetch(url, { headers: { Cookie: `.ROBLOSECURITY=${cookie}` } });
    if (res.status === 401 || res.status === 403) {
      console.error("[roblox] fallback cookie rejected:", res.status);
      await notifyRobloxCookieBroken(`Group transaction check got HTTP ${res.status} - the fallback cookie is likely expired.`);
      return false;
    }
    if (!res.ok) {
      console.error("[roblox] group transactions fetch failed:", res.status);
      return false;
    }
    const data = await res.json().catch(() => ({}));
    // deno-lint-ignore no-explicit-any
    const rows: any[] = data.data || [];
    return rows.some((row) => {
      const details = row.details || {};
      const agent = row.agent || {};
      return String(details.id) === String(gamePassId) && String(agent.id) === String(buyerRobloxId);
    });
  } catch (err) {
    console.error("[roblox] group transaction check error:", err);
    return false;
  }
}

// Posts a Discord webhook alert (if configured) on cookie failure. Not
// deduplicated here - callers (verify-robux-order, the scheduled
// roblox-cookie-healthcheck function) are expected to only call this on
// an actual failure, and the healthcheck function additionally tracks
// healthy->broken transitions so routine checks don't spam the channel.
export async function notifyRobloxCookieBroken(detail: string): Promise<void> {
  const webhook = Deno.env.get("ROBLOX_ALERT_WEBHOOK_URL");
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `:warning: Roblox fallback cookie problem: ${detail}` }),
    });
  } catch (err) {
    console.error("[roblox] failed to post cookie-broken alert:", err);
  }
}
