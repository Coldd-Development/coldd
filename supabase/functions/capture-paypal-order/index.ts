// Captures an approved PayPal order and marks the coldd order paid.
//
// Called by success.html when the buyer returns from PayPal. Approval alone
// does NOT move money - without this capture step the buyer sees a success
// screen and is never charged.
//
// Three things this function has to get right, because it is the point where
// an order becomes fulfilled:
//
//   1. NEVER trust a client-supplied amount or status. The captured figure is
//      read back from PayPal's own response and compared against the order
//      total we computed server-side at create time.
//   2. IDEMPOTENT. success.html polls, buyers refresh, and PayPal itself can
//      be retried. Capturing twice must not double-fulfil or double-count a
//      coupon.
//   3. CORRELATE ON PAYPAL'S DATA. The PayPal order id comes from our own
//      database row, and custom_id is checked against it on the way back, so a
//      caller cannot point this at an unrelated order.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { paypalToken, paypalFetch } from "../_shared/paypal.ts";
import { sendOrderReceipt } from "../_shared/email.ts";
import { resolveGiftReceipt } from "../_shared/gift.ts";
import { recordMarketingOptIn } from "../_shared/marketing.ts";

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
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const orderId = String(body.orderId ?? "").trim();
    if (!orderId) return json({ ok: false, error: "Missing orderId." }, 400);

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .select("id, status, total_usd, coupon_code, paypal_order_id")
      .eq("id", orderId)
      .maybeSingle();
    if (orderErr || !order) return json({ ok: false, error: "Order not found." }, 404);

    // Already settled - return success without touching PayPal again. This is
    // the idempotency guard for refreshes and repeat polls.
    if (order.status === "paid") return json({ ok: true, status: "paid", alreadyPaid: true });
    if (!order.paypal_order_id) return json({ ok: false, error: "Order has no PayPal reference." }, 400);

    const token = await paypalToken();
    const cap = await paypalFetch(`/v2/checkout/orders/${order.paypal_order_id}/capture`, {
      method: "POST",
      token,
      body: "{}",
    });

    // PayPal returns 422 ORDER_ALREADY_CAPTURED when a concurrent call won the
    // race. That is a success from our side, not an error - fall through and
    // reconcile against the order's real state below.
    const alreadyCaptured = cap.status === 422 &&
      JSON.stringify(cap.data ?? {}).includes("ORDER_ALREADY_CAPTURED");

    if (!cap.ok && !alreadyCaptured) {
      console.error("PayPal capture failed", cap.status, cap.data?.name, cap.data?.message);
      return json({ ok: false, error: "PayPal could not complete this payment." }, 502);
    }

    let paypalOrder = cap.data;
    if (alreadyCaptured) {
      const fetched = await paypalFetch(`/v2/checkout/orders/${order.paypal_order_id}`, {
        method: "GET",
        token,
      });
      if (!fetched.ok) return json({ ok: false, error: "Could not confirm payment status." }, 502);
      paypalOrder = fetched.data;
    }

    const unit = paypalOrder?.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const capturedStatus = String(capture?.status ?? paypalOrder?.status ?? "").toUpperCase();

    if (capturedStatus !== "COMPLETED") {
      // PENDING happens for e.g. eChecks. Leaving the order pending is correct:
      // it must not be fulfilled until the funds actually clear.
      return json({ ok: true, status: "pending", paypalStatus: capturedStatus });
    }

    // Amount check. This is the one that stops a tampered or mismatched order
    // being fulfilled for the wrong money.
    const paidValue = Number(capture?.amount?.value ?? NaN);
    const paidCurrency = String(capture?.amount?.currency_code ?? "");
    const expected = Number(order.total_usd);
    if (!Number.isFinite(paidValue) || paidCurrency !== "USD" || Math.abs(paidValue - expected) > 0.005) {
      console.error("PayPal amount mismatch", { orderId: order.id, paidValue, paidCurrency, expected });
      return json({ ok: false, error: "Payment amount did not match the order." }, 409);
    }

    // custom_id is what we stamped at create time. If it does not point back at
    // this order, something is correlated wrong and fulfilling would be a guess.
    if (unit?.custom_id && String(unit.custom_id) !== String(order.id)) {
      console.error("PayPal custom_id mismatch", { orderId: order.id, customId: unit.custom_id });
      return json({ ok: false, error: "Payment did not match the order." }, 409);
    }

    // `.neq("status","paid")` makes the write itself the concurrency guard:
    // two simultaneous captures cannot both see a row to update, so the coupon
    // increment below runs at most once. Same pattern as stripe-webhook.
    const { data: updated } = await admin
      .from("orders")
      .update({
        status: "paid",
        receipt_email: paypalOrder?.payer?.email_address || null,
        paid_at: new Date().toISOString(),
        paypal_capture_id: capture?.id ?? null,
      })
      .eq("id", order.id)
      .neq("status", "paid")
      .select()
      .maybeSingle();

    if (updated) {
      if (updated.coupon_code) {
        const { data: coupon } = await admin
          .from("coupons").select("code, usage_count").eq("code", updated.coupon_code).maybeSingle();
        if (coupon) {
          await admin.from("coupons")
            .update({ usage_count: (coupon.usage_count ?? 0) + 1 })
            .eq("code", updated.coupon_code);
        }
      }
      // PayPal's own order resource carries the payer's email regardless of
      // whether the buyer has a coldd account, so a guest checkout still
      // gets a receipt here (unlike crypto/Robux, which capture no email).
      const guestEmail = paypalOrder?.payer?.email_address || null;
      // Gift orders: send the receipt to the buyer's account email instead
      // of the recipient (order.user_id), and notify the recipient
      // separately - see _shared/gift.ts.
      const giftEmail = await resolveGiftReceipt(admin, { id: order.id, user_id: updated.user_id, purchased_by_user_id: updated.purchased_by_user_id });
      const receipt = await sendOrderReceipt(admin, order.id, giftEmail || guestEmail);
      if (!receipt.ok) console.error("[capture-paypal-order] receipt email failed:", receipt.error);
      if (updated.marketing_opt_in) await recordMarketingOptIn(admin, guestEmail, updated.user_id);
    }

    return json({ ok: true, status: "paid", orderId: order.id });
  } catch (e) {
    console.error("capture-paypal-order error", e instanceof Error ? e.message : e);
    return json({ ok: false, error: "Unexpected error completing PayPal payment." }, 500);
  }
});
