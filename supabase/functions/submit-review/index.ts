// supabase/functions/submit-review/index.ts
//
// Deploy with:
//   supabase functions deploy submit-review
//
// Requires the caller to actually own the product (a paid order
// containing it) - same ownership-check pattern as get-download-url.
// Upserts on (product_id, user_id) so editing a review updates it in
// place rather than creating a duplicate. Reviews are live immediately -
// no approval queue - but an edit resets admin_reviewed_at to null so it
// re-surfaces on staff's radar rather than silently changing unnoticed.
//
// Body: { slug, stars, text }

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

    const body = await req.json().catch(() => ({}));
    const slug = String(body.slug || "");
    const stars = Math.max(1, Math.min(5, Math.round(Number(body.stars) || 0)));
    const text = String(body.text || "").trim().slice(0, 2000);
    if (!slug || !stars || !text) return json({ ok: false, error: "Missing rating or review text." }, 400);

    const { data: product, error: prodErr } = await admin.from("products").select("id").eq("slug", slug).single();
    if (prodErr || !product) return json({ ok: false, error: "Product not found." }, 404);

    const { data: rows, error: ownedErr } = await admin
      .from("order_items")
      .select("id, orders!inner(user_id, status)")
      .eq("product_slug", slug)
      .eq("orders.user_id", userData.user.id)
      .eq("orders.status", "paid")
      .limit(1);
    if (ownedErr) return json({ ok: false, error: "Could not verify ownership." }, 500);
    if (!rows || !rows.length) return json({ ok: false, error: "You can only review products you've purchased." }, 403);

    const { data: profile } = await admin
      .from("profiles")
      .select("username")
      .eq("id", userData.user.id)
      .single();
    // Reviews are public: never fall back to the account email as a display name.
    const userName = (profile && profile.username) || "user";

    const { error: upsertErr } = await admin.from("reviews").upsert(
      {
        product_id: product.id,
        user_id: userData.user.id,
        stars,
        text,
        // Live immediately - no approval gate. Moderation is now
        // hide/reply only; a bad review gets hidden after the fact rather
        // than every review waiting on staff before anyone sees it.
        status: "approved",
        admin_reviewed_at: null,
        user_name: userName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "product_id,user_id" },
    );
    if (upsertErr) return json({ ok: false, error: "Could not save review." }, 500);

    return json({ ok: true });
  } catch (err) {
    console.error("[submit-review] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
