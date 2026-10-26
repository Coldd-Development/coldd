import { codeEmailHtml } from "../_shared/email_design.ts";
// supabase/functions/email-otp/index.ts
//
// Deploy with:
//   supabase functions deploy email-otp
//
// Required secrets (set once):
//   supabase secrets set SMTP_HOST=smtp.migadu.com
//   supabase secrets set SMTP_PORT=465
//   supabase secrets set SMTP_USER=noreply@coldd.dev
//   supabase secrets set SMTP_PASSWORD=your-mailbox-password
//
// Use port 465 (implicit TLS), NOT 587 (STARTTLS) - 587 is known to hang
// from Supabase Edge Functions and cause a platform 503. See the SMTPClient
// setup below.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Edge Functions runtime - no need to set those yourself.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I - avoids misreads
const CODE_LENGTH = 6;
const EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;
// Matches the client-side resend cooldown (auth.js's RESEND_SECONDS) -
// without this, nothing stops a script from spamming send requests for an
// email that isn't even the caller's inbox to receive (rate limited on our
// side, not just disabled in the UI).
const RESEND_COOLDOWN_SECONDS = 30;

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

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

async function hashCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(code);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function emailHtml(code: string): string { return codeEmailHtml("Verify your email", "Enter this code on coldd.dev to verify your email address.", code, EXPIRY_MINUTES); }

// Plain-text alternative - a missing text/plain part is a spam signal, and
// some clients show it verbatim.
function emailText(code: string): string {
  return `Verify your email

Enter this code to confirm your coldd account. It expires in ${EXPIRY_MINUTES} minutes.

    ${code}

Didn't request this? You can ignore this email. Never share your password or verification code.

Questions? support@coldd.dev
coldd Development - https://coldd.dev`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Identify the caller from their own JWT (never trust a client-supplied email).
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Not authenticated." }, 401);
    const user = userData.user;
    const email = user.email;
    if (!email) return json({ ok: false, error: "No email on account." }, 400);

    const admin = createClient(supabaseUrl, serviceKey);
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "send") {
      const { data: existing } = await admin.from("email_otps").select("expires_at").eq("email", email).maybeSingle();
      if (existing) {
        const lastSentAt = new Date(existing.expires_at).getTime() - EXPIRY_MINUTES * 60_000;
        const elapsedSeconds = (Date.now() - lastSentAt) / 1000;
        if (elapsedSeconds < RESEND_COOLDOWN_SECONDS) {
          return json({ ok: false, error: "Please wait a moment before requesting another code." }, 429);
        }
      }

      const code = generateCode();
      const code_hash = await hashCode(code);
      const expires_at = new Date(Date.now() + EXPIRY_MINUTES * 60_000).toISOString();

      const { error: upsertErr } = await admin.from("email_otps").upsert({
        email, code_hash, expires_at, attempts: 0,
      });
      if (upsertErr) return json({ ok: false, error: "Could not create code." }, 500);

      // Port 465 with implicit TLS is the reliable option for outbound SMTP
      // from Supabase Edge Functions. Port 587/STARTTLS is known to hang in
      // this environment and can cause a platform-level 503 timeout.
      const client = new SMTPClient({
        connection: {
          hostname: Deno.env.get("SMTP_HOST")!,
          port: Number(Deno.env.get("SMTP_PORT") ?? "465"),
          tls: true,
          auth: {
            username: Deno.env.get("SMTP_USER")!,
            password: Deno.env.get("SMTP_PASSWORD")!,
          },
        },
      });

      try {
        await client.send({
          from: `coldd Development <${Deno.env.get("SMTP_USER")}>`,
          to: email,
          replyTo: "support@coldd.dev",
          subject: "Your coldd verification code",
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
      if (!code) return json({ ok: false, error: "Missing code." }, 400);

      const { data: row } = await admin.from("email_otps").select("*").eq("email", email).single();
      if (!row) return json({ ok: false, error: "No code found. Request a new one." });
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return json({ ok: false, error: "Code expired. Request a new one." });
      }
      if (row.attempts >= MAX_ATTEMPTS) {
        return json({ ok: false, error: "Too many attempts. Request a new code." });
      }

      const hash = await hashCode(code);
      if (hash !== row.code_hash) {
        await admin.from("email_otps").update({ attempts: row.attempts + 1 }).eq("email", email);
        return json({ ok: false, error: "Incorrect code." });
      }

      await admin.from("profiles").update({ email_verified: true }).eq("id", user.id);
      await admin.from("email_otps").delete().eq("email", email);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[email-otp] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
