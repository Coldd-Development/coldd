// supabase/functions/admin-update-automation/index.ts
//
// Deploy with:
//   supabase functions deploy admin-update-automation
//
// Upserts one row of email_automations (see supabase/lifecycle_automations.sql
// for what each key means). Routed through a function rather than a direct
// client write so the key is validated against the known set and turning an
// automation on always requires a real subject/body - a blank enabled
// automation would silently send empty emails on the next cron tick.
//
// Body: { key, enabled, delayHours, subject, bodyMd }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://coldd.dev";
const KNOWN_KEYS = [
  "abandoned_cart_1", "abandoned_cart_2", "abandoned_cart_3", "post_purchase_review", "reengagement",
  "wishlist_reminder",
  "signup_nudge", "wishlist_price_drop", "getting_started", "resell_upgrade",
  "review_incentive", "repeat_buyer", "winback", "new_for_you",
];

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
    const key = String(body.key || "");
    if (!KNOWN_KEYS.includes(key)) return json({ ok: false, error: "Unknown automation." }, 400);

    const enabled = !!body.enabled;
    const delayHours = Math.max(key === "new_for_you" ? 0 : 1, Math.floor(Number(body.delayHours) || 0));
    const subject = String(body.subject || "").trim();
    const bodyMd = String(body.bodyMd || "").trim();

    if (enabled && (!subject || !bodyMd)) {
      return json({ ok: false, error: "Write a subject and body before turning this on." }, 400);
    }

    const { error: upsertErr } = await admin
      .from("email_automations")
      .update({ enabled, delay_hours: delayHours, subject, body_md: bodyMd, updated_at: new Date().toISOString() })
      .eq("key", key);
    if (upsertErr) return json({ ok: false, error: "Could not save." }, 500);

    return json({ ok: true });
  } catch (err) {
    console.error("[admin-update-automation] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
