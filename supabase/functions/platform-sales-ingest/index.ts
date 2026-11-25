// supabase/functions/platform-sales-ingest/index.ts
//
// One door for every marketplace sale that has no API sync of its own
// (ClearlyDev, Parcel, Creator Store, Payhip). Writes public.platform_sales,
// which the admin home page totals next to the website and BuiltByBit.
//
// Callers: the Creator Store userscript (create.roblox.com) and the ClearlyDev email
// monitor. coldd's Discord bot sends Parcel's messages here too: a body with a `bot`
// field goes to _shared/discord_feed.ts, which signs the bot in with its own key.
//
//   supabase functions deploy platform-sales-ingest --no-verify-jwt
//
// Auth: header x-ingest-key must equal the PLATFORM_INGEST_KEY secret.
//
// POST {
//   platform: 'creatorstore' | 'clearlydev' | 'parcel' | 'payhip',
//   source?: 'userscript' | 'discord' | 'email' | 'api',   (default 'api')
//   sales: [{
//     external_id: string,        unique per platform; re-sending updates the row
//     sold_at: ISO date,
//     product_name?: string,      matched to a coldd product by title when it can be
//     amount: number,             what the buyer paid, in `currency`
//     currency?: 'USD' | 'AUD' | ... | 'ROBUX'   (default 'USD')
//     net_amount?: number,        after the platform's fee, same currency
//     quantity?: number, buyer_name?: string, buyer_ref?: string,
//     status?: 'paid' | 'pending' | 'refunded', raw?: object
//   }]                            max 1000 per call
// }
// -> { ok, received, written, matched, skipped: [{ index, reason }] }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handleBot } from "../_shared/discord_feed.ts";

const PLATFORMS = ["clearlydev", "parcel", "creatorstore", "payhip"];
const SOURCES = ["userscript", "discord", "email", "api", "manual"];
const STATUSES = ["paid", "pending", "refunded"];
const MAX_ROWS = 1000;
// Same DevEx rate the admin panel uses to compare Robux with real money.
const DEVEX_USD_PER_ROBUX = 0.0038;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-ingest-key, x-bot-key",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}
// Constant-time compare so the key can't be guessed a character at a time.
function sameKey(a: string, b: string) {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
function norm(s: string) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function str(v: unknown, max: number) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function money(v: unknown) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : null;
}

// USD per one unit of `cur`, fetched once per request per currency.
async function usdPerUnit(cur: string, cache: Map<string, number>) {
  if (cur === "USD") return 1;
  if (cur === "ROBUX") return DEVEX_USD_PER_ROBUX;
  if (cache.has(cur)) return cache.get(cur)!;
  const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(cur)}&symbols=USD`);
  if (!res.ok) throw new Error(`No ${cur}/USD rate`);
  const rate = Number((await res.json())?.rates?.USD);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Bad ${cur}/USD rate`);
  cache.set(cur, rate);
  return rate;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Body must be JSON." }, 400); }

  if (body && typeof body === "object" && typeof body.bot === "string") {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    return handleBot(req, body, admin);
  }

  const key = Deno.env.get("PLATFORM_INGEST_KEY") || "";
  if (key.length < 24) return json({ error: "Ingest is not set up yet (PLATFORM_INGEST_KEY missing)." }, 503);
  if (!sameKey(req.headers.get("x-ingest-key") || "", key)) return json({ error: "Wrong ingest key." }, 401);

  const platform = String(body?.platform || "");
  if (!PLATFORMS.includes(platform)) return json({ error: "Unknown platform." }, 400);
  const source = SOURCES.includes(body?.source) ? body.source : "api";
  const sales = Array.isArray(body?.sales) ? body.sales : null;
  if (!sales) return json({ error: "sales must be an array." }, 400);
  if (sales.length > MAX_ROWS) return json({ error: `At most ${MAX_ROWS} sales per call.` }, 400);
  if (!sales.length) return json({ ok: true, received: 0, written: 0, matched: 0, skipped: [] });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Product titles for best-effort matching by name.
  const byTitle = new Map<string, string>();
  const prods = await sb.from("products").select("id, title").limit(5000);
  (prods.data || []).forEach((p: any) => { const k = norm(p.title); if (k && !byTitle.has(k)) byTitle.set(k, p.id); });

  const rates = new Map<string, number>();
  const rows: any[] = [];
  const skipped: { index: number; reason: string }[] = [];
  const seen = new Set<string>();
  let matched = 0;

  for (let i = 0; i < sales.length; i++) {
    const s = sales[i] || {};
    const externalId = str(s.external_id, 200);
    if (!externalId) { skipped.push({ index: i, reason: "missing external_id" }); continue; }
    if (seen.has(externalId)) { skipped.push({ index: i, reason: "duplicate in this batch" }); continue; }
    const soldAt = new Date(s.sold_at);
    if (isNaN(soldAt.getTime()) || soldAt.getTime() > Date.now() + 86400000) { skipped.push({ index: i, reason: "bad sold_at" }); continue; }
    const amount = money(s.amount);
    if (amount == null) { skipped.push({ index: i, reason: "bad amount" }); continue; }
    const currency = String(s.currency || "USD").toUpperCase();
    if (currency !== "ROBUX" && !/^[A-Z]{3}$/.test(currency)) { skipped.push({ index: i, reason: "bad currency" }); continue; }
    let perUnit: number;
    try { perUnit = await usdPerUnit(currency, rates); } catch (e) { skipped.push({ index: i, reason: (e as Error).message }); continue; }
    const net = s.net_amount == null ? null : money(s.net_amount);
    const name = str(s.product_name, 300);
    const productId = name ? byTitle.get(norm(name)) || null : null;
    if (productId) matched++;
    seen.add(externalId);
    rows.push({
      platform, source, external_id: externalId, sold_at: soldAt.toISOString(),
      product_id: productId, product_name: name,
      currency, amount, amount_usd: Math.round(amount * perUnit * 10000) / 10000,
      net_amount: net, net_usd: net == null ? null : Math.round(net * perUnit * 10000) / 10000,
      quantity: Math.max(1, Math.min(10000, Math.round(Number(s.quantity) || 1))),
      buyer_name: str(s.buyer_name, 200), buyer_ref: str(s.buyer_ref, 200),
      status: STATUSES.includes(s.status) ? s.status : "paid",
      raw: s.raw && typeof s.raw === "object" ? s.raw : null,
      updated_at: new Date().toISOString(),
    });
  }

  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const up = await sb.from("platform_sales").upsert(chunk, { onConflict: "platform,external_id" });
    if (up.error) return json({ error: "Could not save: " + up.error.message, written }, 500);
    written += chunk.length;
  }

  return json({ ok: true, received: sales.length, written, matched, skipped });
});
