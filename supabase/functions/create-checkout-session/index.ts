// supabase/functions/create-checkout-session/index.ts
//
// Deploy with:
//   supabase functions deploy create-checkout-session
//
// Required secrets (set once):
//   supabase secrets set STRIPE_SECRET_KEY=sk_test_...
//   supabase secrets set SITE_URL=https://coldd.dev
//
// IMPORTANT: if SITE_URL was previously set to the old
// https://vxpeinjected.github.io/coldd value, it must be updated to the
// line above - the secret takes precedence over this file's ALLOWED_ORIGIN
// fallback, so leaving the old secret in place would keep sending Stripe's
// post-checkout redirect to a dead URL even after redeploying this function.
//
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are the same
// three env vars already relied on by supabase/functions/email-otp.
//
// Guest checkout: signing in is optional. If the caller has a real session
// the order is tied to their user_id (so it shows up in their dashboard and
// they can re-download later); if not, orders.user_id is left null and Stripe
// collects the buyer's email itself. Either way, get-order-by-session and
// get-download-url can look the order up by Stripe session id alone, so a
// guest can still see + download from success.html right after paying.
//
// Coupons: an optional couponCode is resolved with the exact same logic
// validate-coupon uses (via _shared/coupon.ts), so the discount shown on
// checkout.html before payment always matches what's actually charged here.
// The discount is applied as a one-time Stripe coupon for the exact computed
// amount (rather than a percentage-off on the whole Stripe session), since
// our coupons can be scoped to only some of the cart's line items.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17?target=deno";
import { priceItems, resolveCoupon, spendTierDiscount, clampCombinedDiscount, activeSaleEvent, saleEventDiscount } from "../_shared/coupon.ts";
import { resolveCampaignCode } from "../_shared/campaign.ts";
import { resolveProductReferral } from "../_shared/referrals.ts";
import { isSiteInMaintenance } from "../_shared/maintenance.ts";
import { genClaimToken, sha256Hex } from "../_shared/order_access.ts";
import { usdTo } from "../_shared/fx.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";

// The "More payment methods" tiles on checkout, beyond the default automatic
// card flow. Most of these are region-locked to a currency that isn't USD
// (Stripe simply won't offer them on a USD session), so a click has to
// reprice the whole order into that currency before Stripe ever sees it.
// Apple Pay/Google Pay aren't distinct Stripe payment_method_types - they're
// express wallet buttons that appear automatically on a 'card' session when
// the browser/device supports them, so both map straight to 'card'/USD, same
// as the plain Card option.
const LOCAL_METHOD_CURRENCY: Record<string, string> = {
  card: "usd",
  apple_pay: "usd",
  google_pay: "usd",
  link: "usd",
  klarna: "usd",
  afterpay_clearpay: "usd",
  zip: "usd",
  mb_way: "eur",
  satispay: "eur",
  bancontact: "eur",
  blik: "pln",
  eps: "eur",
  p24: "eur",
  bizum: "eur",
  pay_by_bank: "gbp",
  pix: "brl",
};
// Real Stripe payment_method_types values to restrict the session to -
// omitted (falls through to Stripe's automatic detection) for card/wallet
// clicks, since those already work fine on the default unrestricted session.
const STRIPE_PAYMENT_METHOD_TYPE: Record<string, string> = {
  link: "link",
  klarna: "klarna",
  afterpay_clearpay: "afterpay_clearpay",
  zip: "zip",
  mb_way: "mb_way",
  satispay: "satispay",
  bancontact: "bancontact",
  blik: "blik",
  eps: "eps",
  p24: "p24",
  bizum: "bizum",
  pay_by_bank: "pay_by_bank",
  pix: "pix",
};

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

    // Identify the caller from their own JWT if they're signed in - but signing
    // in is optional. A guest (no/invalid Authorization header) checks out with
    // orders.user_id left null; Stripe's own hosted page collects their email.
    let user: { id: string; email?: string | null } | null = null;
    if (authHeader) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await userClient.auth.getUser();
      if (userData?.user) user = userData.user;
    }

    const body = await req.json().catch(() => ({}));
    const admin = createClient(supabaseUrl, serviceKey);

    // The maintenance overlay (site-gate.js) is a client-side visual gate
    // only - removing it in DevTools, or just calling this function
    // directly with no browser involved at all, always sailed straight
    // through to a real checkout regardless of site mode. This is the
    // actual enforcement point. Staff stay exempt, same as the overlay's
    // own admin-bypass behavior (site-gate.js's showWhitelistBanner path).
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

    // The live store-wide/scoped sale event (admin Sales tab), if any -
    // applied automatically, stacks with a coupon and the spend tiers.
    const saleEvent = await activeSaleEvent(admin);
    const saleDisc = saleEventDiscount(lines, saleEvent).discount;

    let discount = 0;
    let appliedCouponCode: string | null = null;
    if (body.couponCode) {
      const couponResult = await resolveCoupon(admin, String(body.couponCode), lines);
      // A coupon that no longer resolves (expired/deactivated/limit hit
      // between validate-coupon and now) just quietly doesn't apply rather
      // than blocking checkout - the shopper already saw the discount
      // applied on the page, so failing the whole order here would be a
      // worse experience than a same-price checkout.
      if (couponResult.ok) {
        discount = couponResult.discount;
        appliedCouponCode = couponResult.code;
      }
    }
    // "Email me deals" no longer carries a discount itself - that
    // incentive moved to the site-wide popup (which mints a real one-time
    // coupon instead), so this box is consent-only again. The flag is
    // still recorded on the order for the completion-time marketing_optins
    // upsert.
    const marketingOptIn = !!body.marketingOptIn;
    // Automatic "spend $X, get Y% off" - no code, applies off the real
    // subtotal, stacks with a coupon the same floor-safe way the old
    // marketing discount did.
    discount = clampCombinedDiscount(lines, discount + saleDisc + spendTierDiscount(lines).discount);
    const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
    const campaignCode = await resolveCampaignCode(admin, body.campaignCode);
    const productReferral = await resolveProductReferral(admin, body.refCode, body.refSlug, lines, user?.id ?? null);

    // Gifting: buyer must be signed in (a guest has no id to record as the
    // payer), and the recipient is re-verified server-side rather than
    // trusted from the client, same defense-in-depth as every other
    // payment/admin function here that never trusts a client-supplied id.
    let giftRecipientId: string | null = null;
    if (user && body.giftRecipientUserId) {
      const recipientId = String(body.giftRecipientUserId);
      if (recipientId === user.id) return json({ ok: false, error: "You can't gift an order to yourself." }, 400);
      const { data: recipientProfile } = await admin.from("profiles").select("id").eq("id", recipientId).maybeSingle();
      if (!recipientProfile) return json({ ok: false, error: "Gift recipient not found." }, 400);
      giftRecipientId = recipientId;
    }

    // Create the order + order_items as 'pending' before talking to Stripe,
    // so we have an order_id to hand to Stripe as metadata and correlate on
    // the webhook / success page.
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
        campaign_code: campaignCode,
        sale_event_slug: saleEvent && saleDisc > 0 ? saleEvent.slug : null,
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

    // Guest orders (no account) carry a one-time claim token in the success
    // redirect so a bare Stripe session id isn't enough to view or download
    // the order. Account orders are gated on the buyer's JWT instead.
    const isGuest = !(giftRecipientId || user);
    const claimToken = isGuest ? genClaimToken() : "";
    if (isGuest) {
      await admin.from("orders").update({ claim_token_hash: await sha256Hex(claimToken) }).eq("id", order.id);
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      httpClient: Stripe.createFetchHttpClient(),
      apiVersion: "2024-06-20",
    });

    // "More payment methods" on checkout - a specific local method the buyer
    // picked, or unset for the default automatic card flow. Falls back to
    // the default on anything unrecognised rather than erroring, since this
    // only ever changes which methods Stripe offers, never whether checkout
    // works at all.
    const requestedMethod = String(body.paymentMethodType || "").trim().toLowerCase();
    const currency = LOCAL_METHOD_CURRENCY[requestedMethod] || "usd";
    const stripeMethodType = STRIPE_PAYMENT_METHOD_TYPE[requestedMethod];

    try {
      // Reprice into the method's own currency, one line at a time (Stripe
      // computes its own total from these, so there's no separate "total" to
      // keep in sync - just each line and the discount).
      const convert = (amountUsd: number) => usdTo(amountUsd, currency);
      const lineUnitAmounts = await Promise.all(lines.map((li) => convert(li.unitPrice)));
      const chargedTotal = await convert(total);

      let discounts: { coupon: string }[] | undefined;
      if (discount > 0) {
        const convertedDiscount = await convert(discount);
        const stripeCoupon = await stripe.coupons.create({
          amount_off: Math.round(convertedDiscount * 100),
          currency,
          duration: "once",
          name: appliedCouponCode ?? undefined,
        });
        discounts = [{ coupon: stripeCoupon.id }];
      }

      // Link is a wallet layered on top of card, not a standalone method -
      // Stripe rejects a session that lists it alone with "must include at
      // least one payment method supported by the default currency", since
      // there's no card fallback in the list for it to sit on top of.
      const paymentMethodTypes = stripeMethodType
        ? stripeMethodType === "link" ? ["card", "link"] : [stripeMethodType]
        : undefined;

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        ...(user?.email ? { customer_email: user.email } : {}),
        ...(user ? { client_reference_id: user.id } : {}),
        ...(paymentMethodTypes ? { payment_method_types: paymentMethodTypes } : {}),
        line_items: lines.map((li, i) => ({
          price_data: {
            currency,
            unit_amount: Math.round(lineUnitAmounts[i] * 100),
            product_data: { name: li.title },
          },
          quantity: li.qty,
        })),
        ...(discounts ? { discounts } : {}),
        success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}${isGuest ? `&t=${claimToken}` : ""}`,
        cancel_url: `${siteUrl}/checkout`,
        metadata: { order_id: order.id },
      });

      await admin.from("orders")
        .update({
          stripe_checkout_session_id: session.id,
          stripe_charge_amount: chargedTotal,
          stripe_charge_currency: currency,
        })
        .eq("id", order.id);

      // usage_count is incremented by stripe-webhook once the order actually
      // pays, not here - incrementing at session-creation time would count
      // abandoned/expired/failed checkouts against the coupon's usage_limit.

      return json({ ok: true, url: session.url });
    } catch (stripeErr) {
      console.error("[create-checkout-session] stripe error:", stripeErr);
      await admin.from("orders").update({ status: "canceled" }).eq("id", order.id);
      return json({ ok: false, error: "Could not start checkout with Stripe." }, 500);
    }
  } catch (err) {
    console.error("[create-checkout-session] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
