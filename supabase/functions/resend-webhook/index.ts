// supabase/functions/resend-webhook/index.ts
//
// Deploy with:
//   supabase functions deploy resend-webhook --no-verify-jwt
//
// Public endpoint that receives Resend delivery webhooks (email.sent /
// delivered / opened / clicked / bounced / complained) and records each
// one in public.email_events, so the Marketing panel can show real
// open/click rates per campaign and attribute revenue to email.
//
// Resend signs webhooks with the Svix scheme. Set the signing secret it
// gives you when you create the endpoint:
//   supabase secrets set RESEND_WEBHOOK_SECRET=whsec_xxxxxxxx
// Requests that don't verify are rejected 401 - without the secret set,
// every request is rejected, so configure it before pointing Resend here.
//
// No auth header (Resend can't send one) - hence --no-verify-jwt. The
// signature check is what gates it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

// Svix signature verification. `secret` is the "whsec_..." string; the
// part after the prefix is base64. Header `svix-signature` is a
// space-separated list of "v1,<base64sig>" - any match passes.
async function verify(secret: string, id: string, timestamp: string, payload: string, header: string): Promise<boolean> {
  if (!id || !timestamp || !header) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const keyBytes = b64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = `${id}.${timestamp}.${payload}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = bytesToB64(mac);

  return header.split(" ").some((part) => {
    const [, sig] = part.split(",");
    return sig === expected;
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false }, 405);

  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    console.error("[resend-webhook] RESEND_WEBHOOK_SECRET not set - rejecting");
    return json({ ok: false, error: "not configured" }, 401);
  }

  const raw = await req.text();
  const ok = await verify(
    secret,
    req.headers.get("svix-id") ?? "",
    req.headers.get("svix-timestamp") ?? "",
    raw,
    req.headers.get("svix-signature") ?? "",
  );
  if (!ok) {
    console.warn("[resend-webhook] signature verification failed");
    return json({ ok: false, error: "bad signature" }, 401);
  }

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return json({ ok: false, error: "bad json" }, 400); }

  const type = String(evt?.type || "");
  const data = evt?.data || {};
  const recipient = Array.isArray(data.to) ? data.to[0] : (data.to || null);
  const tags: Array<{ name: string; value: string }> = Array.isArray(data.tags) ? data.tags : [];
  const campaignTag = tags.find((t) => t.name === "campaign_id");
  const campaignId = campaignTag && /^[0-9a-f-]{36}$/i.test(campaignTag.value) ? campaignTag.value : null;
  const linkUrl = data?.click?.link || null;
  const occurredAt = evt?.created_at || data?.created_at || new Date().toISOString();

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await admin.from("email_events").insert({
    resend_email_id: data.email_id || null,
    type,
    recipient,
    campaign_id: campaignId,
    subject: data.subject || null,
    link_url: linkUrl,
    occurred_at: occurredAt,
    raw: evt,
  });
  // A duplicate (Resend retried) hits the dedupe unique index - not an error.
  if (error && !String(error.message).includes("duplicate key")) {
    console.error("[resend-webhook] insert failed:", error.message);
    return json({ ok: false }, 500);
  }

  if (recipient && (type === 'email.complained' || (type === 'email.bounced' && String(data.bounce?.type).toLowerCase() === 'permanent'))) {
    const { error: suppressionError } = await admin.from('email_suppressions').upsert({ email: String(recipient).toLowerCase(), reason: type });
    if (suppressionError) return json({ ok: false }, 500);
  }
  return json({ ok: true });
});
