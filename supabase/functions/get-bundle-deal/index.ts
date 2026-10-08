// supabase/functions/get-bundle-deal/index.ts
//
// Deploy with:
//   supabase functions deploy get-bundle-deal --no-verify-jwt
//
// Read-only lookup for a bundle_deals token, so a page (the wishlist
// panel, in particular) can show "12% off, or 20% off if you get all 3"
// BEFORE checkout, not just apply it silently once someone actually pays.
// bundle_deals itself has no client read policy at all (same as coupons),
// so this is the one sanctioned way to read a deal's terms - same trust
// model as a coupon code or the Stripe session id success.html reads:
// possession of the (long, random) token is the capability, no auth
// needed. Never returns email/user_id, only what a shopper needs to see
// the offer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const admin = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "").slice(0, 200);
    if (!token) return json({ ok: false, error: "Missing token." }, 400);

    const { data: row } = await admin
      .from("bundle_deals")
      .select("slugs, item_pct, bundle_pct, expires_at")
      .eq("token", token)
      .maybeSingle();
    if (!row) return json({ ok: false, error: "Not found." }, 404);
    if (row.expires_at && new Date(row.expires_at) < new Date()) return json({ ok: false, error: "Expired." }, 410);

    return json({ ok: true, slugs: row.slugs, itemPct: row.item_pct, bundlePct: row.bundle_pct });
  } catch (err) {
    console.error("[get-bundle-deal] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
