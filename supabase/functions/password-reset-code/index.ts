// supabase/functions/password-reset-code/index.ts
//
// Deploy with:
//   supabase functions deploy password-reset-code --no-verify-jwt
//
// Reset-by-code, fully handled here so it does not depend on the Supabase dashboard's
// "Reset password" email template (which sends a link, not a code):
//   send   { email }                       -> emails a 6-character code (always answers ok, so it cannot
//                                             be used to find out which emails have accounts)
//   verify { email, code, newPassword }    -> checks the code, sets the new password
// Uses the same SMTP secrets as email-otp. Codes are stored hashed, expire after 10 minutes,
// allow 5 attempts, and a new one cannot be requested within 30 seconds.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;
const ALLOWED_ORIGIN = "https://coldd.dev";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}
function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const RESET_TEMPLATE = "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"><title>Reset your password</title></head>\n<body style=\"margin:0;padding:0;background-color:#030303;\">\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background-color:#030303;background-image:url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2248%22%20height%3D%2248%22%3E%3Cline%20x1%3D%220%22%20y1%3D%2248%22%20x2%3D%2248%22%20y2%3D%220%22%20stroke%3D%22%23ffffff%22%20stroke-width%3D%220.7%22%20opacity%3D%220.035%22%2F%3E%3C%2Fsvg%3E');padding:44px 0 56px;\">\n<tr><td align=\"center\">\n<table width=\"560\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"width:560px;background-color:#0b0b0b;border-radius:8px;overflow:hidden;\">\n<tr><td style=\"background:linear-gradient(90deg,#ff2233 0%,#ff6677 50%,#ff2233 100%);height:3px;line-height:3px;font-size:3px;\">&nbsp;</td></tr>\n\n<tr><td style=\"padding:40px 44px 8px;\">\n<p style=\"margin:0;font-size:9px;letter-spacing:4px;color:#ff3344;text-transform:uppercase;font-weight:700;font-family:Arial,Helvetica,sans-serif;\">coldd Development</p>\n<p style=\"margin:14px 0 0;font-size:22px;color:#ffffff;font-weight:700;font-family:Arial,Helvetica,sans-serif;\">Reset your password</p>\n<p style=\"margin:10px 0 0;font-size:13px;color:#585858;line-height:1.7;font-family:Arial,Helvetica,sans-serif;\">We got a request to reset the password on your account. Enter this code back on the reset page, along with your new password. It expires shortly for your security.</p>\n</td></tr>\n\n<tr><td style=\"padding:26px 44px 30px;\">\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background-color:#111111;border-radius:6px;border:1px solid #1a1a1a;\">\n<tr><td align=\"center\" style=\"padding:28px 22px;\">\n<table cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:linear-gradient(135deg,#cc0011 0%,#ff3344 100%);border-radius:5px;width:100%;\">\n<tr><td align=\"center\" style=\"padding:18px 22px;\">\n<p align=\"center\" style=\"margin:0;text-align:center;font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:700;letter-spacing:6px;color:#ffffff;\">{{ .Token }}</p>\n</td></tr>\n</table>\n</td></tr>\n</table>\n</td></tr>\n\n<tr><td style=\"padding:0 44px;\">\n<table width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td style=\"border-top:1px solid rgba(255,51,68,0.2);font-size:0;line-height:0;\">&nbsp;</td></tr></table>\n</td></tr>\n\n<tr><td style=\"padding:24px 44px 40px;\">\n<p style=\"margin:0;font-size:11px;color:#3e3e3e;line-height:1.8;font-family:Arial,Helvetica,sans-serif;\">\nDidn't request this? You can safely ignore this email - your password won't change.<br><br>\nNeed help? Contact <a href=\"mailto:support@coldd.dev\" style=\"color:#ff3344;text-decoration:none;\">support@coldd.dev</a>.<br>\ncoldd Development will never ask for your password. Any message claiming to be from us that isn't sent from an <strong style=\"color:#7a7a7a;\">@coldd.dev</strong> address is not from us.\n</p>\n</td></tr>\n\n<tr><td style=\"background-color:#070707;border-top:1px solid #141414;padding:18px 44px;\">\n<p style=\"margin:0;font-size:10px;color:#252525;font-family:Arial,Helvetica,sans-serif;\">coldd Development &nbsp;&middot;&nbsp; noreply@coldd.dev</p>\n</td></tr>\n\n<tr><td style=\"background:linear-gradient(90deg,#ff2233 0%,#ff6677 50%,#ff2233 100%);height:2px;line-height:2px;font-size:2px;\">&nbsp;</td></tr>\n</table>\n</td></tr>\n</table>\n</body></html>\n";
function emailHtml(code: string) { return RESET_TEMPLATE.split("{{ .Token }}").join(code); }
function emailText(code: string) {
  return "Reset your password\n\nEnter this code on the coldd reset page. It expires in " + EXPIRY_MINUTES + " minutes.\n\n    " + code +
    "\n\nDidn't request this? You can ignore this email. coldd will never ask for your password, and only emails from an @coldd.dev address are really from us.\n\nQuestions? support@coldd.dev\ncoldd Development - https://coldd.dev";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const email = String(body.email || "").trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) return json({ ok: false, error: "Enter a valid email." }, 400);

    if (action === "send") {
      const { data: existing } = await admin.from("password_reset_codes").select("last_sent_at").eq("email", email).maybeSingle();
      if (existing && (Date.now() - new Date(existing.last_sent_at).getTime()) / 1000 < RESEND_COOLDOWN_SECONDS) {
        return json({ ok: false, error: "Please wait a moment before requesting another code." }, 429);
      }
      const { data: userId } = await admin.rpc("auth_user_id_by_email", { p_email: email });
      // Same answer whether or not an account exists.
      if (!userId) return json({ ok: true });

      const code = generateCode();
      const { error: upsertErr } = await admin.from("password_reset_codes").upsert({
        email,
        code_hash: await hashCode(code),
        expires_at: new Date(Date.now() + EXPIRY_MINUTES * 60_000).toISOString(),
        attempts: 0,
        last_sent_at: new Date().toISOString(),
      });
      if (upsertErr) return json({ ok: false, error: "Could not create code." }, 500);

      const client = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST")!,
          port: Number(Deno.env.get("SMTP_PORT") ?? "465"),
          tls: true,
          auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASSWORD")! },
        },
      });
      try {
        await client.send({
          from: "coldd Development <" + Deno.env.get("SMTP_USER") + ">",
          to: email,
          replyTo: "support@coldd.dev",
          subject: "Reset your coldd password",
          content: emailText(code),
          html: emailHtml(code),
        });
      } finally {
        await client.close();
      }
      return json({ ok: true });
    }

    if (action === "verify") {
      const code = String(body.code || "").trim().toUpperCase();
      const newPassword = String(body.newPassword || "");
      if (code.length < CODE_LENGTH || code.length > 12) return json({ ok: false, error: "Incorrect or expired code." }, 400);
      if (newPassword.length < 8 || newPassword.length > 72) return json({ ok: false, error: "Use 8 to 72 characters for your password." }, 400);

      const { data: row } = await admin.from("password_reset_codes").select("code_hash, expires_at, attempts").eq("email", email).maybeSingle();
      if (!row || new Date(row.expires_at).getTime() < Date.now() || row.attempts >= MAX_ATTEMPTS) {
        return json({ ok: false, error: "Incorrect or expired code." }, 400);
      }
      if (!constantTimeEqual(await hashCode(code), row.code_hash)) {
        await admin.from("password_reset_codes").update({ attempts: row.attempts + 1 }).eq("email", email);
        return json({ ok: false, error: "Incorrect or expired code." }, 400);
      }
      const { data: userId } = await admin.rpc("auth_user_id_by_email", { p_email: email });
      if (!userId) return json({ ok: false, error: "Incorrect or expired code." }, 400);
      const { error: updErr } = await admin.auth.admin.updateUserById(userId as string, { password: newPassword });
      if (updErr) return json({ ok: false, error: "Could not update the password. Try a different one." }, 400);
      await admin.from("password_reset_codes").delete().eq("email", email);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[password-reset-code] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
