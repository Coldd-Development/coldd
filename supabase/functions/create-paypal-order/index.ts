// Creates a coldd order + a PayPal order, and returns the URL to send the
// buyer to for approval.
//
// Mirrors create-checkout-session deliberately: same server-side pricing via
// _shared/coupon.ts, same "write a pending order BEFORE talking to the payment
// provider" ordering, same optional-sign-in behaviour. The two flows should
// stay recognisably the same shape so a fix to one is obviously needed in the
// other.
//
// Prices are ALWAYS recomputed here from the database. The client sends product
// slugs and quantities, never amounts - a client-supplied price is a client-
// controlled price.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { priceItems, resolveCoupon, spendTierDiscount, clampCombinedDiscount, activeSaleEvent, saleEventDiscount } from "../_shared/coupon.ts";
import { resolveCampaignCode } from "../_shared/campaign.ts";
import { resolveProductReferral } from "../_shared/referrals.ts";
import { paypalToken, paypalFetch, money, approveLink, paypalEnv } from "../_shared/paypal.ts";
import { isSiteInMaintenance } from "../_shared/maintenance.ts";
import { genClaimToken, sha256Hex } from "../_shared/order_access.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";

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
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const siteUrl = Deno.env.get("SITE_URL") ?? ALLOWED_ORIGIN;

    // Signing in stays optional, same as card checkout - a guest order just
    // leaves user_id null and PayPal collects the payer's email itself.
    let user: { id: string } | null = null;
    if (authHeader) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await userClient.auth.getUser();
      if (userData?.user) user = userData.user;
    }

    const body = await req.json().catch(() => ({}));
    const admin = createClient(supabaseUrl, serviceKey);

    // See create-checkout-session's identical check for why this exists -
    // the maintenance overlay is a client-side visual gate only.
    if (await isSiteInMaintenance(admin, user?.id)) {
      let isStaff = false;
      if (user) {
        const { data: profile } = await admin.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
        isStaff = !!profile?.is_admin;
      }
      if (!isStaff) return json({ ok: false, error: "coldd is temporarily down for maintenance. Please check back shortly." }, 503);
    }

    const priced = await priceItems(admin, Array.isArray(body.items) ? body.items : [], { bundleToken: body.bundleToken ? String(body.bundleToken) : undefined });
    if (!priced.ok) return json({ ok: false, error: priced.error }, 400);
    const { lines, subtotal } = priced;
    if (subtotal <= 0) return json({ ok: false, error: "Order total must be greater than zero." }, 400);

    const saleEvent = await activeSaleEvent(admin);
    const saleDisc = saleEventDiscount(lines, saleEvent).discount;

    let discount = 0;
    let appliedCouponCode: string | null = null;
    if (body.couponCode) {
      const couponResult = await resolveCoupon(admin, String(body.couponCode), lines);
      // Same call as the Stripe flow: a coupon that stopped resolving between
      // validation and here quietly doesn't apply rather than failing the
      // whole order after the shopper already saw it accepted.
      if (couponResult.ok) {
        discount = couponResult.discount;
        appliedCouponCode = couponResult.code;
      }
    }
    const marketingOptIn = !!body.marketingOptIn;
    discount = clampCombinedDiscount(lines, discount + saleDisc + spendTierDiscount(lines).discount);
    const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
    if (total <= 0) return json({ ok: false, error: "Order total must be greater than zero." }, 400);
    const campaignCode = await resolveCampaignCode(admin, body.campaignCode);
    const productReferral = await resolveProductReferral(admin, body.refCode, body.refSlug, lines, user?.id ?? null);

    // Gifting: same server-side re-verification as create-checkout-session -
    // never trust the recipient id the client got from lookup-gift-recipient
    // without a fresh existence check here.
    let giftRecipientId: string | null = null;
    if (user && body.giftRecipientUserId) {
      const recipientId = String(body.giftRecipientUserId);
      if (recipientId === user.id) return json({ ok: false, error: "You can't gift an order to yourself." }, 400);
      const { data: recipientProfile } = await admin.from("profiles").select("id").eq("id", recipientId).maybeSingle();
      if (!recipientProfile) return json({ ok: false, error: "Gift recipient not found." }, 400);
      giftRecipientId = recipientId;
    }

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .insert({
        user_id: giftRecipientId || (user ? user.id : null),
        purchased_by_user_id: giftRecipientId ? user!.id : null,
        status: "pending",
        subtotal_usd: subtotal,
        discount_usd: discount,
        total_usd: total,
        coupon_code: appliedCouponCode,
        sale_event_slug: saleEvent && saleDisc > 0 ? saleEvent.slug : null,
        payment_provider: "paypal",
        campaign_code: campaignCode,
        marketing_opt_in: marketingOptIn,
        referrer_id: productReferral?.referrerId ?? null,
        ref_product_slug: productReferral?.slug ?? null,
      })
      .select()
      .single();
    if (orderErr || !order) return json({ ok: false, error: "Could not create order." }, 500);

    const { error: itemsErr } = await admin.from("order_items").insert(
      lines.map((li) => ({
        order_id: order.id,
        product_id: li.productId,
        product_slug: li.slug,
        title: li.title,
        licence: li.licence,
        unit_price_usd: li.unitPrice,
        qty: li.qty,
      })),
    );
    if (itemsErr) {
      await admin.from("orders").update({ status: "canceled" }).eq("id", order.id);
      return json({ ok: false, error: "Could not create order items." }, 500);
    }

    // Guest orders carry a one-time claim token in the return URL (see
    // _shared/order_access.ts); account orders are gated on the buyer's JWT.
    const isGuest = !(giftRecipientId || user);
    const claimToken = isGuest ? genClaimToken() : "";
    if (isGuest) {
      await admin.from("orders").update({ claim_token_hash: await sha256Hex(claimToken) }).eq("id", order.id);
    }

    const token = await paypalToken();
    const created = await paypalFetch("/v2/checkout/orders", {
      method: "POST",
      token,
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          // custom_id is what capture-paypal-order correlates on. It survives
          // the whole PayPal round trip, so we never have to trust an order id
          // handed back by the browser.
          custom_id: order.id,
          amount: { currency_code: "USD", value: money(total) },
          description: `coldd order ${String(order.id).slice(0, 8)}`,
        }],
        application_context: {
          brand_name: "coldd",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING", // digital goods only
          return_url: `${siteUrl}/success/?provider=paypal&orderId=${order.id}${isGuest ? `&t=${claimToken}` : ""}`,
          cancel_url: `${siteUrl}/checkout/?canceled=1`,
        },
      }),
    });

    if (!created.ok || !created.data?.id) {
      await admin.from("orders").update({ status: "failed" }).eq("id", order.id);
      console.error("PayPal create failed", created.status, created.data?.name, created.data?.message);
      return json({ ok: false, error: "Could not start PayPal checkout." }, 502);
    }

    await admin.from("orders")
      .update({ paypal_order_id: created.data.id })
      .eq("id", order.id);

    const url = approveLink(created.data);
    if (!url) {
      await admin.from("orders").update({ status: "failed" }).eq("id", order.id);
      return json({ ok: false, error: "PayPal did not return an approval link." }, 502);
    }

    return json({ ok: true, url, orderId: order.id, env: paypalEnv() });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("create-paypal-order error", detail);
    // These messages are ours and contain no secrets - the auth helper never
    // echoes PayPal's response body. Surfacing them turns a useless
    // "unexpected error" into something diagnosable from the browser, which
    // matters most when the credentials or environment are misconfigured.
    const known = detail.startsWith("PayPal credentials are not configured") ||
      detail.startsWith("PayPal auth failed") ||
      detail.startsWith("PayPal auth returned no token");
    return json({
      ok: false,
      error: known ? detail : "Unexpected error starting PayPal checkout.",
      env: paypalEnv(),
    }, known ? 502 : 500);
  }
});
