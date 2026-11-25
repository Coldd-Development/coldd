// supabase/functions/admin-moderate-review/index.ts
//
// Deploy with:
//   supabase functions deploy admin-moderate-review
//
// Same auth/is_admin gate as the other admin-* functions.
//
// Reviews publish immediately on submit - there's no approval queue, so
// 'approve' isn't a real action anymore. Moderation is hide/reply, plus
// an internal 'seen' the admin panel fires when staff open the Reviews
// panel, which just clears the new-review flag without changing anything
// else - not a user-facing button of its own.
//
// 'delete' wipes a review for good, hidden ones included. An imported review (BuiltByBit,
// Creator Store, Parcel) also goes into review_blocks so the syncs never bring it back.
//
// Body: { id, action: 'hide'|'show'|'reply'|'seen'|'delete', reply? }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyUser } from "../_shared/notify.ts";

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
    const id = String(body.id || "");
    const action = body.action;
    if (!id || !["hide", "show", "reply", "seen", "delete"].includes(action)) return json({ ok: false, error: "Invalid request." }, 400);

    if (action === "delete") {
      const { data: row, error: readErr } = await admin.from("reviews").select("id, external_id, source, listing_name, user_name").eq("id", id).maybeSingle();
      if (readErr) return json({ ok: false, error: "Could not read review." }, 500);
      if (!row) return json({ ok: true, gone: true });
      if (row.external_id) {
        const { error: blockErr } = await admin.from("review_blocks").upsert({
          external_id: row.external_id, source: row.source, listing_name: row.listing_name, user_name: row.user_name,
          deleted_by: userData.user.id, deleted_at: new Date().toISOString(),
        }, { onConflict: "external_id" });
        if (blockErr) return json({ ok: false, error: "Could not block the review from coming back." }, 500);
      }
      const { error: delErr } = await admin.from("reviews").delete().eq("id", id);
      if (delErr) return json({ ok: false, error: "Could not delete review." }, 500);
      return json({ ok: true });
    }

    let update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (action === "hide") { update.status = "hidden"; update.admin_reviewed_at = new Date().toISOString(); }
    // Unhide: only a review an admin hid. One waiting for its product (hidden_reason 'unmatched')
    // is published by the sync when that product is on the site.
    else if (action === "show") { update.status = "approved"; update.admin_reviewed_at = new Date().toISOString(); }
    else if (action === "reply") {
      update.reply = body.reply ? String(body.reply).trim().slice(0, 2000) || null : null;
      update.reply_at = new Date().toISOString();
      update.admin_reviewed_at = new Date().toISOString();
    } else if (action === "seen") {
      update = { admin_reviewed_at: new Date().toISOString() };
    }

    let q = admin.from("reviews").update(update).eq("id", id);
    if (action === "show") q = q.is("hidden_reason", null);
    const { data: updated, error: updateErr } = await q.select("user_id, reply, products(title)").maybeSingle();
    if (updateErr) return json({ ok: false, error: "Could not update review." }, 500);

    if (action === "reply" && update.reply && updated?.user_id) {
      const productTitle = (updated.products as { title?: string } | null)?.title || "your product";
      await notifyUser(admin, updated.user_id, "coldd replied to your review", `On ${productTitle}: "${String(update.reply).slice(0, 140)}"`, "/dashboard");
    }

    return json({ ok: true });
  } catch (err) {
    console.error("[admin-moderate-review] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
