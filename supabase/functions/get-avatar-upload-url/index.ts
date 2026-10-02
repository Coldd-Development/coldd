// supabase/functions/get-avatar-upload-url/index.ts
//
// Deploy with:
//   supabase functions deploy get-avatar-upload-url
//
// Same signed-upload-URL pattern as admin-get-upload-url (bytes go straight
// from the browser to Storage, never through this function) but for any
// signed-in user uploading their own profile picture rather than an admin
// uploading product media. Reuses the existing public product-media bucket
// under an avatars/ prefix instead of standing up a new bucket. The path is
// keyed by the caller's own auth id, not anything client-supplied, so a
// user can only ever overwrite their own avatar.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cdnEnabled, cdnPublicUrl, cdnSignedUrl } from "../_shared/cdn.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const MEDIA_BUCKET = "product-media";
const ALLOWED_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

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

    const body = await req.json().catch(() => ({}));
    const contentType = String(body.contentType || "");
    const ext = ALLOWED_EXT[contentType];
    if (!ext) return json({ ok: false, error: "Please pick a JPG, PNG, WEBP, or GIF image." }, 400);

    const admin = createClient(supabaseUrl, serviceKey);
    // Fixed filename per user (not a random one) - a re-upload overwrites
    // the previous avatar in place instead of leaving orphaned files behind
    // every time someone changes their picture.
    const path = `avatars/${userData.user.id}.${ext}`;

    if (cdnEnabled()) {
      return json({
        ok: true,
        driver: "cdn",
        path,
        uploadUrl: await cdnSignedUrl("upload", path, { maxBytes: 5 * 1024 * 1024, overwrite: true }),
        publicUrl: cdnPublicUrl(path),
      });
    }

    const { data: signed, error: signErr } = await admin.storage
      .from(MEDIA_BUCKET)
      .createSignedUploadUrl(path, { upsert: true });
    if (signErr || !signed) return json({ ok: false, error: "Could not create upload URL." }, 500);

    return json({
      ok: true,
      bucket: MEDIA_BUCKET,
      path,
      token: signed.token,
      publicUrl: `${supabaseUrl}/storage/v1/object/public/${MEDIA_BUCKET}/${path}`,
    });
  } catch (err) {
    console.error("[get-avatar-upload-url] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
