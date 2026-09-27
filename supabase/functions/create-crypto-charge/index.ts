// Creates a coldd order and a hosted crypto invoice, and returns the URL to
// send the buyer to.
//
// Mirrors create-paypal-order / create-checkout-session: same server-side
// repricing, same pending-order-before-provider ordering, same optional
// sign-in. Prices are always recomputed from the database - the client sends
// slugs and quantities, never amounts.
//
// Note what this function does NOT do: it never marks anything paid. Crypto
// settles on-chain minutes later, often after the buyer has closed the tab, so
// fulfilment belongs exclusively to the signed webhook.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { priceItems, resolveCoupon, spendTierDiscount, clampCombinedDiscount, activeSaleEvent, saleEventDiscount } from "../_shared/coupon.ts";
import { resolveCampaignCode } from "../_shared/campaign.ts";
import { resolveProductReferral } from "../_shared/referrals.ts";
import { activeProvider } from "../_shared/crypto.ts";
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
      if (couponResult.ok) {
        discount = couponResult.discount;
        appliedCouponCode = couponResult.code;
      }
    }
    const marketingOptIn = !!body.marketingOptIn;
    discount = clampCombinedDiscount(lines, discount + saleDisc + spendTierDiscount(lines).discount);
    const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
    if (total <= 0) return json({ ok: false, error: "Order total must be greater than zero." }, 400);

    const provider = activeProvider();
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

    // RelayPay requires a name and email on the create-transaction call;
    // NOWPayments ignores both. Signed-in buyers use their account email and
    // (when set) their username; guests must supply both at checkout - see
    // the coCryptoGuestName/Email fields in checkout/index.html.
    let customerName = "";
    let customerEmail = "";
    if (user) {
      customerEmail = user.email ?? "";
      const { data: profile } = await admin.from("profiles").select("username").eq("id", user.id).maybeSingle();
      customerName = profile?.username || customerEmail;
    } else {
      customerName = String(body.guestName || "").trim();
      customerEmail = String(body.guestEmail || "").trim();
    }
    if (!customerName || !customerEmail) {
      return json({ ok: false, error: "A name and email are required to pay with crypto." }, 400);
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
        payment_provider: "crypto",
        crypto_provider: provider.name,
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

    const charge = await provider.createCharge({
      orderId: order.id,
      amountUsd: total,
      description: `coldd order ${String(order.id).slice(0, 8)}`,
      // The success page only ever POLLS the order; it cannot mark it paid.
      returnUrl: `${siteUrl}/success/?provider=crypto&orderId=${order.id}${isGuest ? `&t=${claimToken}` : ""}`,
      cancelUrl: `${siteUrl}/checkout/?canceled=1`,
      callbackUrl: `${supabaseUrl}/functions/v1/crypto-webhook`,
      customerName,
      customerEmail,
    });

    if (!charge.ok) {
      await admin.from("orders").update({ status: "failed" }).eq("id", order.id);
      return json({ ok: false, error: charge.error }, 502);
    }

    await admin.from("orders")
      .update({
        crypto_charge_id: charge.providerId,
        crypto_settle_amount: charge.settleAmount,
        crypto_settle_currency: charge.settleCurrency,
      })
      .eq("id", order.id);

    return json({ ok: true, url: charge.url, orderId: order.id });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("create-crypto-charge error", detail);
    const known = detail.startsWith("Crypto payments are not configured");
    return json(
      { ok: false, error: known ? detail : "Unexpected error starting crypto checkout." },
      known ? 503 : 500,
    );
  }
});
