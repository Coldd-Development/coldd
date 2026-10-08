// supabase/functions/save-cart-snapshot/index.ts
//
// Deploy with:
//   supabase functions deploy save-cart-snapshot --no-verify-jwt
//
// Public - checkout works for signed-out guests too, so this can't
// require auth. If a valid session IS present, the snapshot gets tied to
// that account (for the admin panel's email column); otherwise it's
// anonymous. Called (debounced) whenever someone views checkout with
// items in their cart, or edits the cart from there.
//
// Body: { sessionId, items, valueUsd }

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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const sessionId = String(body.sessionId || "").slice(0, 64);
    if (!sessionId) return json({ ok: true });

    // Keep only the small known shape of each cart line so this endpoint cannot be used to store arbitrary blobs.
    const items = Array.isArray(body.items) ? body.items.slice(0, 50).map((i: Record<string, unknown>) => ({
      id: String(i?.id ?? "").slice(0, 120), title: String(i?.title ?? "").slice(0, 200), price: Number(i?.price) || 0,
      image: String(i?.image ?? "").slice(0, 500), tag: String(i?.tag ?? "").slice(0, 60), licence: String(i?.licence ?? "").slice(0, 20), qty: Math.max(1, Math.min(20, Number(i?.qty) || 1)),
    })) : [];
    const valueUsd = Math.max(0, Number(body.valueUsd) || 0);

    let userId: string | null = null;
    let email: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
      const { data: userData } = await userClient.auth.getUser();
      if (userData?.user) {
        userId = userData.user.id;
        const { data: profile } = await admin.from("profiles").select("email").eq("id", userId).single();
        email = profile?.email || userData.user.email || null;
      }
    }

    if (!items.length) {
      await admin.from("cart_snapshots").delete().eq("session_id", sessionId);
      // A signed-in shopper emptying their cart from any tab/device clears
      // every stale snapshot, not just this browser session's row.
      if (userId) await admin.from("cart_snapshots").delete().eq("user_id", userId);
      return json({ ok: true });
    }

    // Exactly one abandoned-cart row per signed-in user. The client's
    // session id lives in sessionStorage, so it changes on every new tab and
    // every browser restart - keying the snapshot on session_id alone spun
    // up a brand-new row (and, on the next cron tick, another "you left
    // something in your cart" email) each visit. jordangal008 had 5 rows and
    // got 3 identical nags in 2 days. Collapse to one row here, carrying the
    // furthest nag step already reached so returning doesn't restart the
    // sequence. Guests (no userId) are unaffected - one row per session is
    // fine there, and the cron never emails a cart with no user_id anyway.
    let carryStep = 0;
    if (userId) {
      const { data: prior } = await admin
        .from("cart_snapshots")
        .select("abandoned_step_sent")
        .eq("user_id", userId);
      carryStep = (prior || []).reduce(
        (m: number, r: { abandoned_step_sent?: number }) => Math.max(m, r.abandoned_step_sent || 0),
        0,
      );
      await admin.from("cart_snapshots").delete().eq("user_id", userId).neq("session_id", sessionId);
    }

    await admin.from("cart_snapshots").upsert({
      session_id: sessionId,
      user_id: userId,
      email,
      items,
      value_usd: Math.round(valueUsd * 100) / 100,
      abandoned_step_sent: carryStep,
      updated_at: new Date().toISOString(),
    });

    return json({ ok: true });
  } catch (err) {
    console.error("[save-cart-snapshot] error:", err);
    return json({ ok: true }); // never block checkout over this
  }
});
