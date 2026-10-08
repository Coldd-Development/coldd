// supabase/functions/admin-delete-product/index.ts
//
// Deploy with:
//   supabase functions deploy admin-delete-product
//
// Same auth/secrets pattern as admin-upsert-product.
//
// PERMANENT delete: removes the products row. Everything that hangs off it goes with it
// (product_legal, reviews, wishlist entries, marketplace listings/tasks cascade; resellers
// are detached). Private files that only this product used (its download file and its
// proof files) are deleted from storage afterwards; a file another product still uses
// (for example a proof video shared between products) is kept.
//
// The one exception: a product that has ever been PURCHASED is hidden instead
// (is_active = false) and the response says so ({ mode: "hidden", orders }). Erasing it
// would break order history and cut off what buyers paid for. Hidden products can be
// restored by editing them and turning Released back on.
//
// Response: { ok: true, mode: "deleted" | "hidden", orders?, filesRemoved? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cdnDeletePrivate, isCdnPath } from "../_shared/cdn.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const FILES_BUCKET = "product-files";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

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

// Paths inside a proof_files / dev_proof_files array ([{ name, path }]; old entries have none).
function pathsOf(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map((f: unknown) => (f && typeof f === "object" ? String((f as Obj).path || "") : "")).filter(Boolean)
    : [];
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
    const id = String(body.id || "");
    if (!id) return json({ ok: false, error: "Missing product id." }, 400);

    const { data: product } = await admin.from("products").select("id, slug, title, storage_path").eq("id", id).maybeSingle();
    if (!product) return json({ ok: true, mode: "deleted", filesRemoved: 0 }); // already gone

    // Purchased products are kept (hidden): order history and buyers' access depend on the row.
    const { count: orders } = await admin.from("order_items").select("id", { count: "exact", head: true }).eq("product_id", id);
    if ((orders ?? 0) > 0) {
      const { error: hideErr } = await admin.from("products").update({ is_active: false }).eq("id", id);
      if (hideErr) return json({ ok: false, error: "Could not remove product." }, 500);
      return json({ ok: true, mode: "hidden", orders });
    }

    // Private files used only by this product.
    const own = new Set<string>();
    if (product.storage_path) own.add(String(product.storage_path));
    const { data: myLegal } = await admin.from("product_legal").select("proof_files, dev_proof_files").eq("product_id", id).maybeSingle();
    pathsOf(myLegal?.proof_files).forEach((p) => own.add(p));
    pathsOf(myLegal?.dev_proof_files).forEach((p) => own.add(p));

    const used = new Set<string>();
    const { data: otherProducts } = await admin.from("products").select("storage_path").neq("id", id).limit(5000);
    for (const r of (otherProducts ?? []) as Obj[]) if (r.storage_path) used.add(String(r.storage_path));
    const { data: otherLegal } = await admin.from("product_legal").select("proof_files, dev_proof_files").neq("product_id", id).limit(5000);
    for (const r of (otherLegal ?? []) as Obj[]) {
      pathsOf(r.proof_files).forEach((p) => used.add(p));
      pathsOf(r.dev_proof_files).forEach((p) => used.add(p));
    }
    const removable = [...own].filter((p) => !used.has(p) && !p.startsWith("_shared/") && !p.includes("placeholder"));

    // Delete the row first, so a failure here never costs files.
    const { error: delErr } = await admin.from("products").delete().eq("id", id);
    if (delErr) {
      console.error("[admin-delete-product] delete failed:", delErr.message);
      return json({ ok: false, error: "Could not delete product." }, 500);
    }

    let filesRemoved = 0;
    for (const path of removable) {
      try {
        if (isCdnPath(path)) await cdnDeletePrivate(path);
        else await admin.storage.from(FILES_BUCKET).remove([path]);
        filesRemoved++;
      } catch (e) {
        console.warn("[admin-delete-product] file cleanup failed:", path, (e as Error).message);
      }
    }
    return json({ ok: true, mode: "deleted", filesRemoved });
  } catch (err) {
    console.error("[admin-delete-product] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
