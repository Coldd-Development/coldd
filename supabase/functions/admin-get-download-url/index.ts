// supabase/functions/admin-get-download-url/index.ts
//
// Deploy with:
//   supabase functions deploy admin-get-download-url
//
// Same auth/is_admin gate as the other admin-* functions. Lets staff
// download a product's real uploaded file straight from the admin panel
// (e.g. to spot-check what a customer receives) without needing a paid
// order of their own - get-download-url's ownership check is the wrong
// tool here since admins usually don't own the product being reviewed.
//
// Also doubles as the signed-URL source for legal proof-of-license/
// proof-of-development uploads (body.path instead of body.productId) -
// those live in the same private product-files bucket under legal/, and
// the same admin-only gate is exactly what should guard viewing them.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { downloadName, signPrivateDownload } from "../_shared/download.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const SIGNED_URL_TTL_SECONDS = 120;
// Proof-of-license/development files are played in the browser (video seeking
// re-requests the file), so those links live longer than a one-shot download.
const PREVIEW_URL_TTL_SECONDS = 900;

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
    const rawPath = String(body.path || "");

    if (rawPath) {
      // Legal-doc path: only ever paths this same admin panel wrote via
      // admin-get-upload-url's legalDoc kind (product-files/<slug>/legal/...).
      // Constrained to that exact shape rather than trusting an arbitrary
      // client-supplied path into the bucket, even though the admin gate
      // above already limits who can call this at all.
      if (!/^(cdn:)?[a-z0-9.\-]+\/legal\/[a-z0-9.\-]+$/.test(rawPath)) {
        return json({ ok: false, error: "Invalid file path." }, 400);
      }
      const url = await signPrivateDownload(admin, rawPath, undefined, PREVIEW_URL_TTL_SECONDS);
      if (!url) return json({ ok: false, error: "Could not generate link." }, 500);
      return json({ ok: true, url });
    }

    const productId = String(body.productId || "");
    if (!productId) return json({ ok: false, error: "Missing product." }, 400);

    const { data: product, error: productErr } = await admin
      .from("products")
      .select("storage_path, title")
      .eq("id", productId)
      .single();
    if (productErr || !product) return json({ ok: false, error: "Product not found." }, 404);
    if (!product.storage_path) return json({ ok: false, error: "No file has been uploaded for this product yet." }, 404);

    const url = await signPrivateDownload(admin, product.storage_path, downloadName(product.storage_path, product.title), SIGNED_URL_TTL_SECONDS);
    if (!url) return json({ ok: false, error: "Could not generate download link." }, 500);

    return json({ ok: true, url });
  } catch (err) {
    console.error("[admin-get-download-url] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
