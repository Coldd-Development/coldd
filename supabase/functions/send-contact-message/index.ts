import { queueEmail, drainEmailQueue } from "../_shared/email_delivery.ts";
// supabase/functions/send-contact-message/index.ts
//
// Deploy with:
//   supabase functions deploy send-contact-message --no-verify-jwt
//
// Backs the /contact page's form. Public/guest-callable - no auth
// required, so anyone can reach us without an account, same trust model
// as validate-coupon's rate limiting below.
//
// The reason -> destination mapping lives here, server-side, not in the
// client payload - a caller can only pick from REASON_EMAILS's keys, never
// supply an arbitrary destination address themselves.
//
// Body: { reason: 'support'|'legal'|'marketing', name, email, message }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { escapeHtml, htmlToText, wrapTransactionalEmail } from "../_shared/email.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_SECONDS = 3600;
const RESEND_API_BASE = "https://api.resend.com";
const FROM_ADDRESS = "coldd contact form <noreply@coldd.dev>";

const REASON_EMAILS: Record<string, { to: string; label: string }> = {
  support: { to: "support@coldd.dev", label: "Support" },
  legal: { to: "legal@coldd.dev", label: "Legal" },
  marketing: { to: "marketing@coldd.dev", label: "Marketing & Business Inquiries" },
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Same reasoning as validate-coupon: the one guest-callable function
    // that sends mail on a visitor's say-so needs a limit, or it's a free
    // relay for spamming three inboxes.
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    const { data: allowed, error: rlErr } = await admin.rpc("check_rate_limit", {
      p_key: `contact:${ip}`,
      p_max: RATE_LIMIT_MAX,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
    });
    if (rlErr || allowed === false) {
      return json({ ok: false, error: "Too many messages sent. Please try again in a bit." }, 429);
    }

    const body = await req.json().catch(() => ({}));
    const reasonKey = String(body.reason || "");
    const reason = REASON_EMAILS[reasonKey];
    if (!reason) return json({ ok: false, error: "Please choose a reason for contacting us." }, 400);

    const name = String(body.name || "").trim().slice(0, 100);
    const email = String(body.email || "").trim().slice(0, 200);
    const message = String(body.message || "").trim().slice(0, 4000);
    if (!name) return json({ ok: false, error: "Please enter your name." }, 400);
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "Please enter a valid email address." }, 400);
    if (!message) return json({ ok: false, error: "Please enter a message." }, 400);

    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return json({ ok: false, error: "Contact form isn't configured yet - email support@coldd.dev directly." }, 503);

    const bodyHtml = `
<p style="margin:0 0 4px;font-size:32px;font-weight:700;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">New contact form message</p>
<p style="margin:0 0 20px;color:#aab2c0;font-size:12px;">Reason: ${escapeHtml(reason.label)}</p>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#1f2127;border-radius:6px;border:1px solid #33363f;padding:16px 18px;margin-bottom:20px;">
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#d7d7d7;padding-bottom:8px;"><strong style="color:#ffffff;">From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#d7d7d7;white-space:pre-wrap;border-top:1px solid #33363f;padding-top:10px;">${escapeHtml(message)}</td></tr>
</table>
<p style="margin:0;color:#aab2c0;font-size:12px;">Reply directly to this email to respond to ${escapeHtml(name)}.</p>
`;
    const html = wrapTransactionalEmail(bodyHtml);

    const deliveryKey = 'contact/'+crypto.randomUUID();
    const result = await queueEmail(admin, { dedupe_key: deliveryKey, kind: 'service', category: 'contact', recipient: reason.to, from_address: FROM_ADDRESS, reply_to: email, subject: `[${reason.label}] Message from ${name}`, html });
    if (!result.ok) return json({ ok: false, error: 'Could not save your message. Please try again.' }, 503);
    try { await drainEmailQueue(admin, deliveryKey); } catch (error) { console.error('[contact] delivery queued', String(error)); }

    return json({ ok: true });
  } catch (err) {
    console.error("[send-contact-message] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
