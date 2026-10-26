// supabase/functions/admin-manage-order/index.ts
//
// Deploy with:
//   supabase functions deploy admin-manage-order
//
// Same auth/is_admin gate as the other admin-* functions. Three actions:
//
//   complete - manually flips a 'pending' order to 'paid'. Real orders
//   normally reach 'paid' automatically via stripe-webhook the moment
//   Stripe confirms payment, so this is only for edge cases (e.g. an
//   out-of-band/manual payment) - it does NOT charge anything.
//
//   refund - actually calls Stripe's refund API against the order's real
//   payment_intent (not just flipping a status flag - a refund that
//   doesn't touch Stripe wouldn't actually return the customer's money).
//   Only allowed on 'paid' orders with a real stripe_payment_intent_id.
//
//   revoke - cuts off download access (get-download-url's ownership check
//   requires status = 'paid') WITHOUT touching payment - for a policy
//   violation or a chargeback dispute where access should stop immediately
//   but the money isn't being returned through this order record. Distinct
//   from refund on purpose; see supabase/orders_revoked_status.sql.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@17?target=deno";
import { notifyUser } from "../_shared/notify.ts";

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
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("is_admin")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const body = await req.json().catch(() => ({}));
    const orderId = String(body.orderId || "");
    const action = body.action === "refund" ? "refund" : body.action === "complete" ? "complete" : body.action === "revoke" ? "revoke" : null;
    if (!orderId || !action) return json({ ok: false, error: "Missing orderId or action." }, 400);

    const { data: order, error: orderErr } = await admin.from("orders").select("*").eq("id", orderId).single();
    if (orderErr || !order) return json({ ok: false, error: "Order not found." }, 404);

    if (action === "complete") {
      if (order.status !== "pending") return json({ ok: false, error: "Only pending orders can be marked completed." }, 400);
      const { error: updErr } = await admin
        .from("orders")
        .update({ status: "paid", paid_at: order.paid_at ?? new Date().toISOString() })
        .eq("id", orderId);
      if (updErr) return json({ ok: false, error: "Could not update the order." }, 500);
      if (order.user_id) await notifyUser(admin, order.user_id, "Order completed", "Your order has been marked completed - your download is ready.", "/dashboard");
      return json({ ok: true });
    }

    if (action === "revoke") {
      if (order.status !== "paid") return json({ ok: false, error: "Only paid orders can have their license revoked." }, 400);
      // Reusing refund_reason rather than adding a revoked_reason column -
      // the two are mutually exclusive states (an order is refunded XOR
      // revoked, never both), so one "why this order lost access" field
      // covers both without ambiguity.
      const reason = body.reason ? String(body.reason).slice(0, 500) : "Revoked by staff";
      const { error: updErr } = await admin
        .from("orders")
        .update({ status: "revoked", refund_reason: reason })
        .eq("id", orderId);
      if (updErr) return json({ ok: false, error: "Could not revoke the license." }, 500);
      if (order.user_id) await notifyUser(admin, order.user_id, "License revoked", reason, "/dashboard");
      return json({ ok: true });
    }

    // action === "refund"
    if (order.status !== "paid") return json({ ok: false, error: "Only paid orders can be refunded." }, 400);
    if (order.payment_provider === "store_credit") {
      const {error}=await admin.from("orders").update({status:"refunded",refund_reason:String(body.reason||"Store credit refunded").slice(0,500)}).eq("id",orderId).eq("status","paid");
      if(error) return json({ok:false,error:"Could not refund store credit."},500);
      return json({ok:true});
    }
    if (!order.stripe_payment_intent_id) {
      return json({ ok: false, error: "This order has no payment on file to refund." }, 400);
    }

    const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
      httpClient: Stripe.createFetchHttpClient(),
      apiVersion: "2024-06-20",
    });

    try {
      await stripe.refunds.create({ payment_intent: order.stripe_payment_intent_id });
    } catch (stripeErr) {
      console.error("[admin-manage-order] stripe refund error:", stripeErr);
      return json({ ok: false, error: "Stripe could not process the refund." }, 500);
    }

    const reason = body.reason ? String(body.reason).slice(0, 500) : "Refunded by staff";
    const { error: updErr } = await admin
      .from("orders")
      .update({ status: "refunded", refund_reason: reason })
      .eq("id", orderId);
    if (updErr) return json({ ok: false, error: "Refund succeeded on Stripe but the order record could not be updated - check Stripe directly." }, 500);
    if (order.user_id) await notifyUser(admin, order.user_id, "Order refunded", reason, "/dashboard");

    return json({ ok: true });
  } catch (err) {
    console.error("[admin-manage-order] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
