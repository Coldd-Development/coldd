// supabase/functions/admin-import-review/index.ts
//
// Deploy with:
//   supabase functions deploy admin-import-review
//
// Same auth/is_admin gate as the other admin-* functions. Manually adds
// a review sourced from another platform - published immediately
// (status='approved'), no moderation queue, since an admin is vetting it
// by hand already.
//
// Body: { slug?, stars, text, reviewerName, platform, byline? }
// An empty slug files a GENERAL review (product_id null): it appears on /reviews but never
// counts toward any product's rating. byline is the "Role or company" line under the name.

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
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("is_admin")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const body = await req.json().catch(() => ({}));
    const slug = String(body.slug || "");
    const stars = Math.max(1, Math.min(5, Math.round(Number(body.stars) || 0)));
    const text = String(body.text || "").trim().slice(0, 2000);
    const reviewerName = String(body.reviewerName || "").trim().slice(0, 80) || "Anonymous";
    const platform = String(body.platform || "Other").trim().slice(0, 40) || "Other";
    const byline = String(body.byline || "").trim().slice(0, 80) || null;
    if (!stars || !text) return json({ ok: false, error: "Missing rating or review text." }, 400);

    let productId: string | null = null;
    if (slug) {
      const { data: product, error: prodErr } = await admin.from("products").select("id").eq("slug", slug).single();
      if (prodErr || !product) return json({ ok: false, error: "Product not found." }, 404);
      productId = product.id;
    }

    const { error: insErr } = await admin.from("reviews").insert({
      product_id: productId,
      user_id: null,
      byline,
      stars,
      text,
      user_name: reviewerName,
      source: platform,
      status: "approved",
    });
    if (insErr) return json({ ok: false, error: "Could not import review." }, 500);

    return json({ ok: true });
  } catch (err) {
    console.error("[admin-import-review] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
