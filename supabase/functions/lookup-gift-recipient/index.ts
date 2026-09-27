// supabase/functions/lookup-gift-recipient/index.ts
//
// Deploy with:
//   supabase functions deploy lookup-gift-recipient
//
// Checkout's "gift this order" flow: resolves a buyer-typed email to a
// real coldd account before checkout will let them proceed with the gift
// toggle on. Any signed-in caller can use this (not admin-only) - see
// admin-upsert-product/index.ts for the auth boilerplate this mirrors,
// minus the is_admin gate.
//
// Deliberately returns the minimum: { found, userId, displayName } and
// never the resolved account's email.
//
// Email-only (a username lookup used to also be accepted, but a display
// name is public/guessable in a way an email isn't - that turned this into
// a way to probe arbitrary usernames for a hit). Rate limited per caller
// (supabase/rate_limits.sql) on top of that, since even an email-only
// lookup is still an { found: true/false } oracle a signed-in account
// could otherwise hammer to scan for real addresses.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://coldd.dev";
const RATE_LIMIT_MAX = 15;
const RATE_LIMIT_WINDOW_SECONDS = 60;

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

    // Keyed on the caller's own account, not IP - this is auth-gated, so
    // the account itself is the identity worth throttling regardless of
    // how many IPs it's used from.
    const { data: allowed, error: rlErr } = await admin.rpc("check_rate_limit", {
      p_key: `gift-lookup:${userData.user.id}`,
      p_max: RATE_LIMIT_MAX,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    });
    if (!rlErr && allowed === false) {
      return json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, 429);
    }

    const body = await req.json().catch(() => ({}));
    const query = String(body.query || "").trim().toLowerCase();
    if (!query || !EMAIL_RE.test(query)) return json({ ok: false, error: "Enter a valid email." }, 400);

    // Matched exactly (case-insensitive) - this resolves ONE specific
    // account the buyer already knows, not a directory search.
    const { data: profile } = await admin
      .from("profiles")
      .select("id, username, email")
      .ilike("email", query)
      .maybeSingle();

    if (!profile) return json({ ok: true, found: false });

    if (profile.id === userData.user.id) {
      return json({ ok: false, error: "You can't gift an order to yourself." }, 400);
    }

    return json({
      ok: true,
      found: true,
      userId: profile.id,
      displayName: profile.username || (profile.email ? profile.email.split("@")[0] : "that user"),
    });
  } catch (err) {
    console.error("[lookup-gift-recipient] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
