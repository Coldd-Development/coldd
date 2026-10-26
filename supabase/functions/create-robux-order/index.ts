import { sendOrderReceipt } from "../_shared/email.ts";
// supabase/functions/create-robux-order/index.ts
//
// Deploy with:
//   supabase functions deploy create-robux-order
//
// Robux checkout doesn't go through Stripe - Roblox handles the actual
// payment entirely on its own site when the buyer purchases a gamepass.
// This only writes the 'pending' order/order_items rows (mirrors the
// DB-write half of create-checkout-session) and hands back each item's
// gamepass ID so the frontend can link straight to Roblox's purchase
// page. verify-robux-order (separate function) checks the buyer's
// Roblox inventory afterward and marks the order paid.
//
// Unlike Stripe checkout, signing in is REQUIRED here (not optional) -
// verifying a Robux purchase means checking a specific Roblox account's
// inventory, so we have to know who the buyer is and that they've
// linked a Roblox account, before an order can even be created.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { priceRobuxItems, getValidRobloxToken, type RobuxPricedLine } from "../_shared/roblox.ts";
import { leasePassForOrder } from "../_shared/roblox_pool.ts";
import { resolveCampaignCode } from "../_shared/campaign.ts";
import { resolveProductReferral } from "../_shared/referrals.ts";
import {
  type PricedLine, priceItems, resolveCoupon, spendTierDiscountRobux, clampCombinedDiscount,
  clampCombinedDiscountRobux, robuxLegalHeadroom, activeSaleEvent, saleEventDiscount,
} from "../_shared/coupon.ts";
import { isSiteInMaintenance } from "../_shared/maintenance.ts";
import { priceAddons, insertOrderAddons } from "../_shared/addons.ts";

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

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in to pay with Robux." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    // See create-checkout-session's identical check for why this exists -
    // the maintenance overlay is a client-side visual gate only.
    if (await isSiteInMaintenance(admin, userData.user.id)) {
      const { data: profile } = await admin.from("profiles").select("is_admin").eq("id", userData.user.id).maybeSingle();
      if (!profile?.is_admin) return json({ ok: false, error: "coldd is temporarily down for maintenance. Please check back shortly." }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const { data: robloxAcct } = await admin
      .from("roblox_accounts")
      .select("roblox_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!robloxAcct && !body.useStoreCredit) {
      return json({ ok: false, error: "Link your Roblox account first.", code: "NOT_LINKED" }, 400);
    }


    const allItems = Array.isArray(body.items) ? body.items : [];
    // Items flagged addonOnly are add-ons for a product the buyer already owns: no product line to price.
    const items = allItems.filter((i: { addonOnly?: boolean }) => !i?.addonOnly);
    const priced = items.length
      ? await priceRobuxItems(admin, items)
      : { ok: true as const, lines: [] as RobuxPricedLine[], totalRobux: 0 };
    if (!priced.ok) return json({ ok: false, error: priced.error }, 400);
    const { lines } = priced;

    // The same cart priced in USD. Carries the curated-bundle percentage each
    // line earned (see priceItems), which is applied to the Robux price here,
    // and is reused below to turn coupon / sale discounts into Robux.
    const usdPriced = items.length
      ? await priceItems(admin, items)
      : { ok: true as const, lines: [] as PricedLine[], subtotal: 0 };
    if (usdPriced.ok) {
      for (const li of lines) {
        if (li.licence === "resell" || li.disallowSales) continue;
        const u = usdPriced.lines.find((x) => x.slug === li.slug && x.licence === "standard");
        if (!u || !(u.bundlePct > 0)) continue;
        // Never below the product's own Robux floor (min_sale_robux /
        // max_discount_pct) - the same floor the USD line already respected.
        const discounted = Math.round(li.unitRobux * (1 - u.bundlePct / 100));
        const floored = Math.max(discounted, li.floorRobux);
        if (floored < li.unitRobux) {
          li.unitRobux = floored;
          li.unitPriceUsd = u.unitPrice;
          li.title += ` (Bundle ${u.bundlePct}% off)`;
        }
      }
    }
    const totalRobux = lines.reduce((sum, li) => sum + li.unitRobux * li.qty, 0);

    // Per-product add-ons ride on top, outside every discount - see
    // _shared/addons.ts. Their Robux price is the add-on's own Robux price.
    const addonPriced = await priceAddons(admin, allItems, { userId: userData.user.id, gift: !!body.giftRecipientUserId });
    if (!addonPriced.ok) return json({ ok: false, error: addonPriced.error }, 400);
    const { addons, totalUsd: addonsUsd, totalRobux: addonsRobux } = addonPriced;
    if (totalRobux <= 0 && addonsRobux <= 0) return json({ ok: false, error: "Order total must be greater than zero." }, 400);
    // A product's add-ons can only be paid in Robux where the product itself can be.
    const noRobux = addons.find((a) => !a.robuxOk);
    if (noRobux) return json({ ok: false, error: `${noRobux.title} (${noRobux.productTitle}) can't be bought with Robux.` }, 400);

    const subtotalUsd = lines.reduce((sum, li) => sum + li.unitPriceUsd * li.qty, 0);

    let discountUsd = 0;
    let appliedCouponCode: string | null = null;
    let saleEventSlug: string | null = null;
    let finalTotalRobux = totalRobux;
    let finalTotalUsd = subtotalUsd;
    const marketingOptIn = !!body.marketingOptIn;
    {
      // The coupon and the sale event are both defined in USD (scope,
      // percentage, and floor-safety all live in USD terms), so they're
      // resolved against a parallel USD pricing of the same cart, combined
      // and floor-clamped there, then converted onto the real Robux total
      // as the same proportion of the USD subtotal they take off - never a
      // flat USD->Robux rate, since each product's admin-set robux_price
      // has no fixed ratio to its USD price. The spend tier is then
      // evaluated directly in Robux (see spendTierDiscountRobux), and the
      // whole Robux reduction is re-clamped against the cart's Robux legal
      // headroom so no product_legal floor is breached.
      const saleEvent = await activeSaleEvent(admin);
      let usdReduction = 0;
      if (usdPriced.ok && usdPriced.subtotal > 0) {
        let couponUsd = 0;
        if (body.couponCode) {
          const couponResult = await resolveCoupon(admin, String(body.couponCode), usdPriced.lines);
          if (couponResult.ok) { couponUsd = couponResult.discount; appliedCouponCode = couponResult.code; }
        }
        const saleUsd = saleEventDiscount(usdPriced.lines, saleEvent).discount;
        if (saleUsd > 0) saleEventSlug = saleEvent!.slug;
        usdReduction = clampCombinedDiscount(usdPriced.lines, couponUsd + saleUsd);
      }

      let robuxAfterUsdDiscounts = totalRobux;
      if (usdReduction > 0 && usdPriced.ok && usdPriced.subtotal > 0) {
        robuxAfterUsdDiscounts = Math.round(totalRobux * (1 - usdReduction / usdPriced.subtotal));
      }

      const headroomRobux = robuxLegalHeadroom(lines);
      const tierResult = spendTierDiscountRobux(robuxAfterUsdDiscounts, headroomRobux);
      const rawRobuxReduction = (totalRobux - robuxAfterUsdDiscounts) + tierResult.discountRobux;
      finalTotalRobux = Math.max(0, totalRobux - clampCombinedDiscountRobux(lines, rawRobuxReduction));

      // discount_usd/total_usd on the order row are informational
      // (receipts/analytics) - derived from the real combined discount
      // actually applied in Robux, not summed from two different bases.
      const totalDiscountFraction = totalRobux > 0 ? (totalRobux - finalTotalRobux) / totalRobux : 0;
      discountUsd = Math.round(subtotalUsd * totalDiscountFraction * 100) / 100;
      finalTotalUsd = Math.max(0, Math.round((subtotalUsd - discountUsd) * 100) / 100);
    }

    const campaignCode = await resolveCampaignCode(admin, body.campaignCode);
    const productReferral = await resolveProductReferral(admin, body.refCode, body.refSlug, lines, userData.user.id);

    // Gifting: same server-side re-verification as the other three checkout
    // functions - never trust the recipient id the client got from
    // lookup-gift-recipient without a fresh existence check here. The
    // BUYER's own linked Roblox account (roblox_buyer_id above) is
    // completely unaffected by this - they're still who actually pays on
    // Roblox's side regardless of who the order is gifted to.
    let giftRecipientId: string | null = null;
    if (body.giftRecipientUserId) {
      const recipientId = String(body.giftRecipientUserId);
      if (recipientId === userData.user.id) return json({ ok: false, error: "You can't gift an order to yourself." }, 400);
      const { data: recipientProfile } = await admin.from("profiles").select("id").eq("id", recipientId).maybeSingle();
      if (!recipientProfile) return json({ ok: false, error: "Gift recipient not found." }, 400);
      giftRecipientId = recipientId;
    }

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .insert({
        user_id: giftRecipientId || userData.user.id,
        purchased_by_user_id: giftRecipientId ? userData.user.id : null,
        status: "pending",
        currency: "robux",
        subtotal_usd: Math.round((subtotalUsd + addonsUsd) * 100) / 100,
        discount_usd: discountUsd,
        total_usd: Math.round((finalTotalUsd + addonsUsd) * 100) / 100,
        total_robux: finalTotalRobux + addonsRobux,
        coupon_code: appliedCouponCode,
        sale_event_slug: saleEventSlug,
        roblox_buyer_id: robloxAcct?.roblox_id || null,
        campaign_code: campaignCode,
        marketing_opt_in: marketingOptIn,
        referrer_id: productReferral?.referrerId ?? null,
        ref_product_slug: productReferral?.slug ?? null,
      })
      .select()
      .single();
    if (orderErr || !order) return json({ ok: false, error: "Could not create order." }, 500);

    const { error: itemsErr } = lines.length === 0 ? { error: null } : await admin.from("order_items").insert(
      lines.map((li) => ({
        order_id: order.id,
        product_id: li.productId,
        product_slug: li.slug,
        title: li.title,
        licence: li.licence || "standard",
        unit_price_usd: li.unitPriceUsd,
        unit_price_robux: li.unitRobux,
        qty: li.qty,
      })),
    );
    if (itemsErr) {
      await admin.from("orders").update({ status: "canceled" }).eq("id", order.id);
      return json({ ok: false, error: "Could not create order items." }, 500);
    }
    if (!(await insertOrderAddons(admin, order.id, addons))) {
      await admin.from("orders").update({ status: "canceled" }).eq("id", order.id);
      return json({ ok: false, error: "Could not record your add-ons." }, 500);
    }

    let creditApplied=0;
    if(body.useStoreCredit){
      const {data:credit,error:creditError}=await admin.rpc("apply_store_credit",{p_user_id:userData.user.id,p_order_id:order.id,p_currency:"robux",p_amount:body.storeCreditAmount??null,p_min_remainder:1});
      if(creditError||!credit?.ok){await admin.from("orders").update({status:"canceled"}).eq("id",order.id);return json({ok:false,error:credit?.error||"Could not apply store credit."},400);}
      creditApplied=Number(credit.applied);
      if(credit.paid){await sendOrderReceipt(admin,order.id,userData.user.email).catch(console.error);return json({ok:true,url:"https://coldd.dev/success?order_id="+order.id});}
    }
    if(!robloxAcct){await admin.from("orders").update({status:"canceled"}).eq("id",order.id);return json({ok:false,error:"Link your Roblox account to pay the remaining Robux.",code:"NOT_LINKED"},400);}

    // One pass for the whole order, priced to the exact (post-discount)
    // total - not one pass per product. The buyer makes a single Roblox
    // purchase regardless of how many items are in the cart.
    // Buyer's OAuth token lets leasePassForOrder also check they don't
    // already own the pass it's about to hand them (needs the
    // user.inventory-item:read scope; silently skipped if not granted).
    const buyerToken = await getValidRobloxToken(admin, userData.user.id).catch(() => null);
    const leased = await leasePassForOrder(
      admin, order.id, finalTotalRobux + addonsRobux-creditApplied, robloxAcct.roblox_id, buyerToken?.accessToken,
    );
    if (!leased.ok) {
      await admin.from("orders").update({ status: "canceled" }).eq("id", order.id);
      return json({ ok: false, error: leased.error, code: leased.code }, 503);
    }

    await admin.from("orders")
      .update({ roblox_gamepass_id: leased.pass.gamepassId })
      .eq("id", order.id);

    return json({
      ok: true,
      orderId: order.id,
      totalRobux: finalTotalRobux + addonsRobux-creditApplied,
      creditApplied,
      // The single pass to buy. priceRobux is what we actually set on Roblox,
      // which verification checks against - it is not merely the display total.
      gamePassId: leased.pass.gamepassId,
      priceRobux: leased.pass.priceRobux,
      // Held so the buyer knows the window; the pass returns to the pool after
      // this and the order has to be restarted.
      expiresInSeconds: 900,
      items: lines.map((li) => ({
        slug: li.slug,
        title: li.title,
        qty: li.qty,
        unitRobux: li.unitRobux,
      })).concat(addons.map((a) => ({
        slug: a.productSlug,
        title: `${a.title} - ${a.productTitle}`,
        qty: 1,
        unitRobux: a.unitRobux,
      }))),
    });
  } catch (err) {
    console.error("[create-robux-order] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
