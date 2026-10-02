// supabase/functions/admin-get-upload-url/index.ts
//
// Deploy with:
//   supabase functions deploy admin-get-upload-url
//
// Same auth pattern as the other admin-* functions. Mints a short-lived
// signed Storage upload URL so the admin's browser can PUT a file straight
// to Storage (thumbnail/gallery image, or the real product download file)
// without routing the bytes through this function. The caller then saves
// the returned `path` back onto the product row (image/gallery via
// admin-upsert-product, or products.storage_path for the download file).
//
// Requires two buckets to exist (create via Dashboard -> Storage):
//   - "product-media": PUBLIC bucket, for thumbnails/gallery images.
//   - "product-files": PRIVATE bucket, already created in the Phase A
//     purchase-flow setup - reused here for admin-uploaded product files.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cdnEnabled, cdnPublicUrl, cdnSignedUrl, withCdnPrefix } from "../_shared/cdn.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const MEDIA_BUCKET = "product-media";
const FILES_BUCKET = "product-files";

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

function safeName(name: string) {
  return String(name || "file").toLowerCase().replace(/[^a-z0-9.\-]+/g, "-").slice(-100);
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
    const kind = ["gallery", "productFile", "unreleasedFile", "legalDoc"].includes(body.kind) ? body.kind : "thumbnail";
    const filename = safeName(String(body.filename || "file"));
    const unique = crypto.randomUUID().slice(0, 8);

    // legalDoc shares productFile's private bucket - proof-of-license/
    // proof-of-development uploads are internal paperwork, not public
    // product media, so they get no publicUrl back (see admin.js's
    // legal-doc list, which fetches a short-lived signed URL on click
    // instead of storing a permanent one).
    const bucket = kind === "unreleasedFile" || kind === "productFile" || kind === "legalDoc" ? FILES_BUCKET : MEDIA_BUCKET;
    const path = kind === "unreleasedFile"
      ? `unreleased/${unique}-${filename}`
      : (() => {
        const productSlug = safeName(String(body.productSlug || "untitled"));
        const subdir = kind === "productFile" ? "files" : kind === "gallery" ? "gallery" : kind === "legalDoc" ? "legal" : "thumbnails";
        return `${productSlug}/${subdir}/${unique}-${filename}`;
      })();

    // Public media (thumbnails/gallery) goes to the CDN host when configured;
    // private files always stay in Supabase Storage.
    if (bucket === MEDIA_BUCKET && cdnEnabled()) {
      const cdnPath = `media/${path}`; // NOT products/: the *.coldd.dev/product* Worker route would swallow it
      return json({
        ok: true,
        driver: "cdn",
        path: cdnPath,
        uploadUrl: await cdnSignedUrl("upload", cdnPath, { maxBytes: 10 * 1024 * 1024 }),
        publicUrl: cdnPublicUrl(cdnPath),
      });
    }

    // Private files (paid downloads, staged files, legal docs) also live on the
    // hosting account, outside the web root. The stored path carries a "cdn:"
    // prefix so download/delete code knows which backend owns the file. The
    // browser sends it in chunks (offset/last query params) so file size isn't
    // capped by PHP's per-request limits.
    if (bucket === FILES_BUCKET && cdnEnabled()) {
      return json({
        ok: true,
        driver: "cdn",
        chunked: true,
        path: withCdnPrefix(path),
        uploadUrl: await cdnSignedUrl("upload", path, { maxBytes: 4 * 1024 * 1024 * 1024, priv: true }),
        publicUrl: null,
      });
    }

    const { data: signed, error: signErr } = await admin.storage
      .from(bucket)
      .createSignedUploadUrl(path);
    if (signErr || !signed) return json({ ok: false, error: "Could not create upload URL." }, 500);

    return json({
      ok: true,
      bucket,
      path,
      token: signed.token,
      uploadUrl: signed.signedUrl,
      publicUrl: bucket === MEDIA_BUCKET
        ? `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`
        : null,
    });
  } catch (err) {
    console.error("[admin-get-upload-url] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
