// supabase/functions/get-post-purchase-upsell/index.ts
//
// Deploy with:
//   supabase functions deploy get-post-purchase-upsell
//
// Backs the success page's "Build more for less" - same trust model as
// get-order-by-session (possession of the Stripe session id or order id
// is the capability; no auth check needed, guest checkout included) since
// this is called from the exact same page, right after that lookup
// already succeeded.
//
// Finds other active products sharing a genre with what was just bought
// (product_genres, the same dynamic genre detection the dashboard's
// Recommended for you and the checkout cross-sell both already use),
// mints a bundle_deals row for the result, and returns priced items so
// the page can show "each at X% off, or Y% off if you get them all"
// without a second round trip once the buyer actually adds them - the
// token is what makes the discount real at checkout, this response is
// just the preview.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mintBundleDeal } from "../_shared/discount_codes.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const ITEM_PCT = 15;
const BUNDLE_PCT = 10; // additional, on top of ITEM_PCT, if every offered item is bought together
const LIMIT = 6;
const EXPIRES_DAYS = 3;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const sessionId = String(body.sessionId || "");
    const orderId = String(body.orderId || "");
    if (!sessionId && !orderId) return json({ ok: false, error: "Missing order reference." }, 400);

    const query = admin.from("orders").select("id, user_id, status, order_items(product_slug)");
    const { data: order } = await (orderId ? query.eq("id", orderId) : query.eq("stripe_checkout_session_id", sessionId)).maybeSingle();
    if (!order || order.status !== "paid") return json({ ok: true, items: [] });

    // deno-lint-ignore no-explicit-any
    const boughtSlugs: string[] = (order.order_items || []).map((i: any) => i.product_slug).filter(Boolean);
    if (!boughtSlugs.length) return json({ ok: true, items: [] });

    const { data: candidateRows } = await admin.rpc("get_checkout_cross_sell", { p_slugs: boughtSlugs, p_limit: LIMIT, p_user_id: order.user_id ?? null });
    // deno-lint-ignore no-explicit-any
    const candidateSlugs: string[] = (candidateRows || []).map((r: any) => r.product_slug);
    if (!candidateSlugs.length) return json({ ok: true, items: [] });

    const { data: products } = await admin
      .from("products")
      .select("slug, title, description, image, price_usd, product_legal(min_sale_usd, disallow_sales, max_discount_pct)")
      .in("slug", candidateSlugs)
      .eq("is_active", true);
    // deno-lint-ignore no-explicit-any
    const eligible = (products || []).filter((p: any) => {
      const legal = Array.isArray(p.product_legal) ? p.product_legal[0] : p.product_legal;
      return !legal?.disallow_sales;
    });
    if (!eligible.length) return json({ ok: true, items: [] });

    const token = await mintBundleDeal(admin, {
      slugs: eligible.map((p: { slug: string }) => p.slug),
      itemPct: ITEM_PCT,
      bundlePct: BUNDLE_PCT,
      source: "post_purchase",
      userId: order.user_id,
      expiresInDays: EXPIRES_DAYS,
    });
    if (!token) return json({ ok: true, items: [] });

    // deno-lint-ignore no-explicit-any
    const items = eligible.map((p: any) => {
      const legal = Array.isArray(p.product_legal) ? p.product_legal[0] : p.product_legal;
      const minSaleUsd = Number(legal?.min_sale_usd) || 0;
      const maxPct = Math.max(0, Math.min(100, Number(legal?.max_discount_pct) || 0));
      // Effective floor: the dollar minimum, or what a max_discount_pct%
      // cut off list would reach - whichever is higher. Must match
      // _shared/coupon.ts's floorUsd so this shown price is the price the
      // checkout will actually charge.
      const pctFloor = maxPct > 0 ? Math.round(Number(p.price_usd) * (1 - maxPct / 100) * 100) / 100 : 0;
      const floor = Math.max(minSaleUsd, pctFloor);
      const discounted = Math.round(Number(p.price_usd) * (1 - ITEM_PCT / 100) * 100) / 100;
      const bundleDiscounted = Math.round(Number(p.price_usd) * (1 - (ITEM_PCT + BUNDLE_PCT) / 100) * 100) / 100;
      return {
        slug: p.slug,
        title: p.title,
        description: p.description || "",
        image: p.image,
        priceUsd: Number(p.price_usd),
        itemPriceUsd: floor > 0 ? Math.max(discounted, floor) : discounted,
        bundlePriceUsd: floor > 0 ? Math.max(bundleDiscounted, floor) : bundleDiscounted,
      };
    });

    return json({ ok: true, token, itemPct: ITEM_PCT, bundlePct: BUNDLE_PCT, items });
  } catch (err) {
    console.error("[get-post-purchase-upsell] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
