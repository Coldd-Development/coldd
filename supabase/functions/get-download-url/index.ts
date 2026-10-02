// supabase/functions/get-download-url/index.ts
//
// Deploy with:
//   supabase functions deploy get-download-url
//
// No new secrets required - reuses the auto-injected SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY, plus SUPABASE_ANON_KEY (already set for
// email-otp/create-checkout-session).
//
// This is the actual enforcement point for "you must have paid to
// download": the product-files Storage bucket is private with no public
// policies, so this signed URL is the only way a file ever leaves it.
//
// Access model (shared with get-order-by-session / submit-reseller-info via
// _shared/order_access.ts):
//   - Account order (orders.user_id set): caller MUST present a JWT for that
//     user. The id in the success URL is only a lookup key, never a bearer
//     token - forwarding the link gets the recipient nothing.
//   - Guest order (orders.user_id null): caller MUST present the one-time
//     `claim_token` (?t= in the success redirect, hashed in
//     orders.claim_token_hash), and only for GUEST_WINDOW_MS after payment.
//     A bare Stripe session id - which also shows up in the Stripe
//     dashboard and webhook logs - is not enough. Past the window the guest
//     claims a free account with their checkout email.
// A signed-in caller can omit the ids/token entirely and use their normal
// owned-orders lookup (e.g. redownloading later from the dashboard).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { downloadName, signPrivateDownload } from "../_shared/download.ts";
import { verifyOrderAccess } from "../_shared/order_access.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const SIGNED_URL_TTL_SECONDS = 120;

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

    const body = await req.json().catch(() => ({}));
    const slug = String(body.slug || "");
    const sessionId = String(body.sessionId || "");
    const token = String(body.token || "");
    // v4 UUID only - a non-uuid orderId would throw a Postgres 22P02.
    const orderId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.orderId || ""))
      ? String(body.orderId)
      : "";
    if (!slug) return json({ ok: false, error: "Missing product." }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    let owned = false;
    if (sessionId || orderId) {
      // Account order -> caller must be signed in as the buyer.
      // Guest order  -> caller must present the one-time ?t= claim token.
      // (see _shared/order_access.ts)
      const q = admin
        .from("orders")
        .select("status, user_id, purchased_by_user_id, paid_at, created_at, claim_token_hash, order_items(product_slug)");
      const { data: order, error: orderErr } = await (
        sessionId ? q.eq("stripe_checkout_session_id", sessionId) : q.eq("id", orderId)
      ).maybeSingle();
      if (orderErr) return json({ ok: false, error: "Could not verify ownership." }, 500);

      const getUserId = async (): Promise<string | null> => {
        if (!authHeader) return null;
        const sessionUserClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
        const { data } = await sessionUserClient.auth.getUser();
        return data?.user?.id ?? null;
      };
      const verdict = await verifyOrderAccess(order, getUserId, token, { requirePaid: true });
      if (!verdict.ok) return json({ ok: false, code: verdict.code, error: verdict.error }, verdict.status);

      owned = (order!.order_items || []).some((i: { product_slug: string }) => i.product_slug === slug);
      if (!owned) return json({ ok: false, error: "That product isn't on this order." }, 403);
    } else {
      if (!authHeader) return json({ ok: false, error: "Please sign in." }, 401);
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

      // Ownership check: does this user have a PAID order containing this slug?
      const { data: rows, error: ownedErr } = await admin
        .from("order_items")
        .select("id, orders!inner(user_id, status)")
        .eq("product_slug", slug)
        .eq("orders.user_id", userData.user.id)
        .eq("orders.status", "paid")
        .limit(1);
      if (ownedErr) return json({ ok: false, error: "Could not verify ownership." }, 500);
      owned = !!rows && rows.length > 0;
    }
    if (!owned) return json({ ok: false, error: "You don't own this product." }, 403);

    const { data: product, error: productErr } = await admin
      .from("products")
      .select("storage_path, title")
      .eq("slug", slug)
      .single();
    if (productErr || !product) return json({ ok: false, error: "Product not found." }, 404);

    const dlName = downloadName(product.storage_path, product.title);
    const url = await signPrivateDownload(admin, product.storage_path, dlName, SIGNED_URL_TTL_SECONDS);
    if (!url) return json({ ok: false, error: "Could not generate download link." }, 500);

    return json({ ok: true, url, filename: dlName });
  } catch (err) {
    console.error("[get-download-url] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
