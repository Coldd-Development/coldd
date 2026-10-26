import { codeEmailHtml } from "../_shared/email_design.ts";
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

function emailHtml(code: string): string { return codeEmailHtml("Reset your password", "Enter this code on the coldd.dev reset page with your new password.", code, EXPIRY_MINUTES); }
function emailText(code: string) {
  return "Reset your password\n\nEnter this code on the coldd reset page. It expires in " + EXPIRY_MINUTES + " minutes.\n\n    " + code +
    "\n\nDidn't request this? You can ignore this email. Never share your password or verification code.\n\nQuestions? support@coldd.dev\ncoldd Development - https://coldd.dev";
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
