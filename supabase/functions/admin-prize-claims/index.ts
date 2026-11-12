// supabase/functions/admin-prize-claims/index.ts
//
// Deploy with:
//   supabase functions deploy admin-prize-claims
//
// Admin Giveaways panel backend. Same auth/is_admin gate as the other
// admin-* functions.
//
//   action "list"     -> every claim, newest first, each with a short-lived
//                        signed URL for its proof screenshot
//   action "fulfil"   -> pending -> fulfilled. Product prizes are granted to
//                        the winner's account (a $0 'granted' order, same as
//                        admin-grant-product) unless they already own it or
//                        grant:false is sent.
//   action "decline"  -> pending -> declined, with a required reason the
//                        winner sees in their notification
//   action "reopen"   -> fulfilled/declined -> pending (for a mis-click). Does
//                        not revoke a product that was already granted.
//
// The winner is notified (nav bell) on fulfil and decline.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyUser } from "../_shared/notify.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const BUCKET = "prize-claims";
const PROOF_URL_TTL = 60 * 60;
const PRIZE_LABEL: Record<string, string> = { robux: "Robux", product: "Product", currency: "Real currency", other: "Prize" };

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

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("is_admin, username")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
    const actorName = (profile as { username?: string }).username || userData.user.email || "Admin";

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "list") {
      const { data: rows, error } = await admin
        .from("prize_claims")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) return json({ ok: false, error: "Could not load claims." }, 500);
      const claims = rows || [];
      const paths = claims.map((c: { proof_path: string }) => c.proof_path).filter(Boolean);
      const urls: Record<string, string> = {};
      if (paths.length) {
        const { data: signed } = await admin.storage.from(BUCKET).createSignedUrls(paths, PROOF_URL_TTL);
        (signed || []).forEach((s: { path: string | null; signedUrl: string }) => { if (s.path && s.signedUrl) urls[s.path] = s.signedUrl; });
      }
      return json({ ok: true, claims: claims.map((c: Record<string, unknown>) => ({ ...c, proof_url: urls[String(c.proof_path)] || null })) });
    }

    const id = String(body.id || "");
    if (!id) return json({ ok: false, error: "Missing claim." }, 400);
    const { data: claim, error: claimErr } = await admin.from("prize_claims").select("*").eq("id", id).single();
    if (claimErr || !claim) return json({ ok: false, error: "Claim not found." }, 404);

    const stamp = { reviewed_by: userData.user.id, reviewed_by_name: actorName, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const what = claim.prize_type === "product" ? (claim.product_title || "Product") : (PRIZE_LABEL[claim.prize_type] || "Prize");

    if (action === "fulfil") {
      if (claim.status !== "pending") return json({ ok: false, error: "Only claims awaiting confirmation can be fulfilled." }, 409);

      let orderId: string | null = claim.order_id || null;
      let granted = false;
      let alreadyOwned = false;
      if (claim.prize_type === "product" && claim.product_id && body.grant !== false && !orderId) {
        const { data: owned } = await admin
          .from("order_items")
          .select("id, orders!inner(user_id, status)")
          .eq("product_slug", claim.product_slug)
          .eq("orders.user_id", claim.user_id)
          .eq("orders.status", "paid")
          .limit(1);
        if (owned && owned.length) {
          alreadyOwned = true;
        } else {
          const { data: product } = await admin.from("products").select("id, slug, title").eq("id", claim.product_id).maybeSingle();
          if (!product) return json({ ok: false, error: "That product no longer exists. Decline the claim or untick the grant." }, 409);
          const { data: order, error: orderErr } = await admin
            .from("orders")
            .insert({ user_id: claim.user_id, status: "paid", currency: "usd", subtotal_usd: 0, discount_usd: 0, total_usd: 0, source: "granted", paid_at: new Date().toISOString() })
            .select("id")
            .single();
          if (orderErr || !order) return json({ ok: false, error: "Could not create the order for this prize." }, 500);
          const { error: itemErr } = await admin.from("order_items").insert({
            order_id: order.id, product_id: product.id, product_slug: product.slug, title: product.title, licence: "standard", unit_price_usd: 0, qty: 1,
          });
          if (itemErr) {
            await admin.from("orders").delete().eq("id", order.id);
            return json({ ok: false, error: "Could not grant the product." }, 500);
          }
          orderId = order.id;
          granted = true;
        }
      }

      // Guard on status so two staff clicking at once can't double-fulfil.
      const { data: upd, error: updErr } = await admin
        .from("prize_claims")
        .update({ status: "fulfilled", decline_reason: null, order_id: orderId, ...stamp })
        .eq("id", id)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();
      if (updErr || !upd) return json({ ok: false, error: "Could not update the claim (it may have just been reviewed)." }, 409);

      const productPrize = claim.prize_type === "product";
      await notifyUser(
        admin,
        claim.user_id,
        "Prize claim fulfilled",
        productPrize
          ? `${what} is now in your Licenses (${claim.ref}). Enjoy!`
          : `Your ${what.toLowerCase()} prize for ${claim.ref} has been sent. Enjoy!`,
        productPrize ? "/dashboard?panel=owned" : "/claim/#claims",
      );
      return json({ ok: true, claim: upd, granted, alreadyOwned });
    }

    if (action === "decline") {
      if (claim.status !== "pending") return json({ ok: false, error: "Only claims awaiting confirmation can be declined." }, 409);
      const reason = String(body.reason || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 1000);
      if (reason.length < 3) return json({ ok: false, error: "Add a reason - the winner sees it." }, 400);
      const { data: upd, error: updErr } = await admin
        .from("prize_claims")
        .update({ status: "declined", decline_reason: reason, ...stamp })
        .eq("id", id)
        .eq("status", "pending")
        .select("*")
        .maybeSingle();
      if (updErr || !upd) return json({ ok: false, error: "Could not update the claim (it may have just been reviewed)." }, 409);
      await notifyUser(admin, claim.user_id, "Prize claim declined", `${claim.ref} (${what}) was declined: ${reason}`, "/claim/#claims");
      return json({ ok: true, claim: upd });
    }

    if (action === "reopen") {
      if (claim.status === "pending") return json({ ok: false, error: "This claim is already awaiting confirmation." }, 409);
      const { data: upd, error: updErr } = await admin
        .from("prize_claims")
        .update({ status: "pending", decline_reason: null, ...stamp })
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (updErr || !upd) return json({ ok: false, error: "Could not reopen the claim." }, 500);
      return json({ ok: true, claim: upd });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[admin-prize-claims] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
