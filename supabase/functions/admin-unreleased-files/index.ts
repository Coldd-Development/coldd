// supabase/functions/admin-unreleased-files/index.ts
//
// Deploy with:
//   supabase functions deploy admin-unreleased-files
//
// CRUD for the "Unreleased" file-staging area (see supabase/unreleased_files.sql).
// Files are uploaded straight to Storage by the browser via admin-get-upload-url
// (kind: "unreleasedFile"); this function only manages the tracking row + the
// delete/rename side of things, same split as admin-upsert-product does for
// real product files.
//
// Body: { action: "list" }
//       { action: "create", storagePath, displayName, sizeBytes }
//       { action: "rename", id, displayName }
//       { action: "delete", id }
//       { action: "download", id }
//       { action: "release", id }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { downloadName, signPrivateDownload } from "../_shared/download.ts";
import { cdnDeletePrivate, isCdnPath } from "../_shared/cdn.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const FILES_BUCKET = "product-files";
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
    const action = String(body.action || "");

    if (action === "list") {
      const { data, error } = await admin
        .from("unreleased_files")
        .select("id, display_name, storage_path, size_bytes, created_at")
        .order("created_at", { ascending: false });
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, files: data });
    }

    if (action === "create") {
      const storagePath = String(body.storagePath || "");
      const displayName = String(body.displayName || "").trim();
      const sizeBytes = Number.isFinite(body.sizeBytes) ? body.sizeBytes : null;
      if (!storagePath || !displayName) return json({ ok: false, error: "Missing storagePath or displayName." }, 400);

      const { data, error } = await admin
        .from("unreleased_files")
        .insert({ storage_path: storagePath, display_name: displayName, size_bytes: sizeBytes, uploaded_by: userData.user.id })
        .select("id, display_name, storage_path, size_bytes, created_at")
        .single();
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true, file: data });
    }

    if (action === "rename") {
      const id = String(body.id || "");
      const displayName = String(body.displayName || "").trim();
      if (!id || !displayName) return json({ ok: false, error: "Missing id or displayName." }, 400);

      const { error } = await admin.from("unreleased_files").update({ display_name: displayName }).eq("id", id);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "download") {
      const id = String(body.id || "");
      if (!id) return json({ ok: false, error: "Missing id." }, 400);

      const { data: row } = await admin.from("unreleased_files").select("storage_path, display_name").eq("id", id).maybeSingle();
      if (!row?.storage_path) return json({ ok: false, error: "File not found." }, 404);

      const url = await signPrivateDownload(admin, row.storage_path, downloadName(row.storage_path, row.display_name), SIGNED_URL_TTL_SECONDS);
      if (!url) return json({ ok: false, error: "Could not generate download link." }, 500);
      return json({ ok: true, url });
    }

    // Fires once a staged file has actually become a real product (see
    // admin.js's startProductFromUnreleased) - the file itself is now
    // owned by that product's storage_path, only the staging row (and its
    // "you have N files to release" reminder on the dashboard) is stale.
    // Deliberately does NOT touch Storage, unlike "delete" below.
    if (action === "release") {
      const id = String(body.id || "");
      if (!id) return json({ ok: false, error: "Missing id." }, 400);

      const { error } = await admin.from("unreleased_files").delete().eq("id", id);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === "delete") {
      const id = String(body.id || "");
      if (!id) return json({ ok: false, error: "Missing id." }, 400);

      const { data: row } = await admin.from("unreleased_files").select("storage_path").eq("id", id).maybeSingle();
      if (row?.storage_path) {
        if (isCdnPath(row.storage_path)) await cdnDeletePrivate(row.storage_path);
        else await admin.storage.from(FILES_BUCKET).remove([row.storage_path]);
      }

      const { error } = await admin.from("unreleased_files").delete().eq("id", id);
      if (error) return json({ ok: false, error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[admin-unreleased-files] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
