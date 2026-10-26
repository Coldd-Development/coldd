import { codeEmailHtml } from "../_shared/email_design.ts";
// supabase/functions/claim-account/index.ts
//
// Deploy with:
//   supabase functions deploy claim-account
//
// Lets an account that has no real email on record - in practice a
// Roblox-first sign-up, which gets a synthetic, undeliverable
// roblox-<id>@roblox.coldd.internal address - "claim" itself by adding a
// real email + password. Discord / Google accounts already carry the
// email their provider hands over, so they never need this.
//
// Two steps, both signed-in and both re-checking eligibility:
//   { action: 'send', email }              -> emails a 6-digit code to the
//                                             NEW address (proof they own it)
//   { action: 'verify', email, code, password }
//                                          -> sets the email + password and
//                                             marks the account claimed
//
// Reuses the email_otps table (keyed by the target email) and the same
// SMTP path as email-otp.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const PLACEHOLDER_RE = /@roblox\.coldd\.internal$/i;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EXPIRY_MIN = 10;
const MAX_ATTEMPTS = 5;

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
function genCode() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
async function hash(code: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function validEmail(e: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 && !PLACEHOLDER_RE.test(e); }
function validPassword(p: string) { return typeof p === "string" && p.length >= 8 && p.length <= 128 && /[A-Za-z]/.test(p) && /[0-9]/.test(p); }

function codeEmail(code: string) {
  const text = `Confirm your email for coldd

Enter this code to finish adding an email and password to your account. It expires in ${EXPIRY_MIN} minutes.

    ${code}

Didn't do this? You can ignore this email - your account isn't changed until the code is entered.

coldd Development - https://coldd.dev`;
  const html = codeEmailHtml("Confirm your email", "Enter this code on coldd.dev to add an email and password to your account.", code, EXPIRY_MIN);
  return { text, html };
}

async function sendCode(to: string, code: string) {
  const client = new SMTPClient({
    connection: {
      hostname: Deno.env.get("SMTP_HOST")!,
      port: Number(Deno.env.get("SMTP_PORT") ?? "465"),
      tls: true,
      auth: { username: Deno.env.get("SMTP_USER")!, password: Deno.env.get("SMTP_PASSWORD")! },
    },
  });
  const { text, html } = codeEmail(code);
  try {
    await client.send({
      from: `coldd Development <${Deno.env.get("SMTP_USER")}>`,
      to,
      replyTo: "support@coldd.dev",
      subject: "Confirm your email for coldd",
      content: text,
      html,
    });
  } finally {
    await client.close();
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);
    const user = userData.user;

    // Eligibility: only accounts without a real, deliverable email.
    if (user.email && !PLACEHOLDER_RE.test(user.email)) {
      return json({ ok: false, error: "This account already has an email. Use Account -> Security to change it." }, 400);
    }

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const email = String(body.email || "").trim().toLowerCase();

    if (!validEmail(email)) return json({ ok: false, error: "Enter a valid email address." }, 400);

    // Not already used by another account.
    const { data: taken } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (taken && taken.id !== user.id) return json({ ok: false, error: "That email is already in use." }, 409);

    if (action === "send") {
      const { data: existing } = await admin.from("email_otps").select("expires_at").eq("email", email).maybeSingle();
      if (existing) {
        const lastSent = new Date(existing.expires_at).getTime() - EXPIRY_MIN * 60_000;
        if ((Date.now() - lastSent) / 1000 < 30) return json({ ok: false, error: "Please wait a moment before requesting another code." }, 429);
      }
      const code = genCode();
      const { error: upErr } = await admin.from("email_otps").upsert({
        email, code_hash: await hash(code), expires_at: new Date(Date.now() + EXPIRY_MIN * 60_000).toISOString(), attempts: 0,
      });
      if (upErr) return json({ ok: false, error: "Could not create a code." }, 500);
      await sendCode(email, code);
      return json({ ok: true });
    }

    if (action === "verify") {
      const code = String(body.code || "").trim().toUpperCase();
      const password = String(body.password || "");
      if (!code) return json({ ok: false, error: "Enter the code from your email." }, 400);
      if (!validPassword(password)) return json({ ok: false, error: "Password must be at least 8 characters and include a letter and a number." }, 400);

      const { data: row } = await admin.from("email_otps").select("*").eq("email", email).maybeSingle();
      if (!row) return json({ ok: false, error: "No code found. Request a new one." }, 400);
      if (new Date(row.expires_at).getTime() < Date.now()) return json({ ok: false, error: "Code expired. Request a new one." }, 400);
      if (row.attempts >= MAX_ATTEMPTS) return json({ ok: false, error: "Too many attempts. Request a new code." }, 429);
      if ((await hash(code)) !== row.code_hash) {
        await admin.from("email_otps").update({ attempts: row.attempts + 1 }).eq("email", email);
        return json({ ok: false, error: "Incorrect code." }, 400);
      }

      // We verified they control this inbox, so no second Supabase confirm.
      const { error: updErr } = await admin.auth.admin.updateUserById(user.id, { email, password, email_confirm: true });
      if (updErr) {
        console.error("[claim-account] updateUserById failed:", updErr.message);
        return json({ ok: false, error: /already been registered|exists/i.test(updErr.message) ? "That email is already in use." : "Could not update the account." }, 500);
      }
      await admin.from("profiles").update({ email, email_verified: true, updated_at: new Date().toISOString() }).eq("id", user.id);
      await admin.from("email_otps").delete().eq("email", email);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[claim-account] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
