// supabase/functions/get-order-by-session/index.ts
//
// Deploy with:
//   supabase functions deploy get-order-by-session
//
// (Regular deploy is fine - called via coldSupabase.functions.invoke(...) like
// every other function here, which always sends the anon key as a valid JWT
// even for a signed-out caller, so the platform's gateway-level JWT check
// still passes. No --no-verify-jwt needed, unlike stripe-webhook which is
// called directly by Stripe with no Supabase JWT at all.)
//
// Backs success.html's post-payment polling. Access is gated by
// _shared/order_access.ts:
//   - account order  -> caller must present a JWT for orders.user_id
//   - guest order     -> caller must present the one-time ?t= claim token
//                        (minted at checkout, hashed in orders.claim_token_hash)
// A bare Stripe session id / order UUID is no longer sufficient on its own.
//
// Returns only status + line items + a `guest` flag - no email, no payment
// details, nothing beyond what success.html needs to render.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyOrderAccess } from "../_shared/order_access.ts";

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";

    const body = await req.json().catch(() => ({}));
    const sessionId = String(body.sessionId || "").slice(0, 200);
    const orderId = String(body.orderId || "").slice(0, 100);
    const token = String(body.token || "").slice(0, 200);
    if (!sessionId && !orderId) return json({ ok: false, error: "Missing session id." }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    const query = admin
      .from("orders")
      .select("id, status, user_id, purchased_by_user_id, paid_at, created_at, claim_token_hash, order_items(product_slug, title, qty, licence)");
    const { data: order, error } = await (orderId ? query.eq("id", orderId) : query.eq("stripe_checkout_session_id", sessionId)).maybeSingle();
    if (error) return json({ ok: false, error: "Could not look up order." }, 500);
    if (!order) return json({ ok: false, error: "Order not found." }, 404);

    const getUserId = async (): Promise<string | null> => {
      if (!authHeader) return null;
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
      const { data } = await userClient.auth.getUser();
      return data?.user?.id ?? null;
    };

    // Status poll runs while a crypto order is still "pending", so don't
    // require paid here - but the wider guest window is fine, the buyer
    // only just left checkout.
    const verdict = await verifyOrderAccess(order, getUserId, token, { requirePaid: false });
    if (!verdict.ok) return json({ ok: false, code: verdict.code, error: verdict.error }, verdict.status);

    return json({
      ok: true,
      status: order.status,
      items: order.order_items || [],
      guest: !order.user_id,
    });
  } catch (err) {
    console.error("[get-order-by-session] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
