import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Access-Control-Allow-Origin": "https://coldd.dev",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json",
  } });
}

export async function referralContext(req: Request, adminOnly = false) {
  if (req.method === "OPTIONS") return { response: reply({ ok: true }) };
  if (req.method !== "POST") return { response: reply({ ok: false, error: "Method not allowed." }, 405) };
  const url = Deno.env.get("SUPABASE_URL")!;
  const client = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return { response: reply({ ok: false, error: "Please sign in." }, 401) };
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (adminOnly) {
    const { data: profile } = await admin.from("profiles").select("is_admin").eq("id", data.user.id).single();
    if (!profile?.is_admin) return { response: reply({ ok: false, error: "Admin access required." }, 403) };
  }
  return { admin, user: data.user };
}

export function paymentDetails(body: Record<string, unknown>) {
  const paypal = String(body.paypalEmail || "").trim().toLowerCase();
  let gamepass: string | null = null;
  if (body.gamepassUrl) {
    try {
      const url = new URL(String(body.gamepassUrl));
      const match = url.pathname.match(/^\/game-pass\/([1-9][0-9]*)(?:\/.*)?$/);
      if (url.protocol === "https:" && ["www.roblox.com", "roblox.com"].includes(url.hostname) && !url.username && !url.password && !url.port && match) {
        gamepass = `https://www.roblox.com/game-pass/${match[1]}`;
      }
    } catch { /* Validation */ }
  }
  return { paypal: paypal || null, gamepass };
}
