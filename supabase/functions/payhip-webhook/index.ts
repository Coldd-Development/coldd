// supabase/functions/payhip-webhook/index.ts
//
// Payhip's sale webhook (Payhip Settings > Developer > Webhook Endpoint, events
// "paid" and "refunded"). Each paid order becomes one row in
// public.platform_sales (platform 'payhip', source 'api'), keyed on Payhip's
// order id; a "refunded" event marks that same row refunded.
//
//   supabase functions deploy payhip-webhook --no-verify-jwt
//   URL: https://ekinmytmudjwfaqaqswp.supabase.co/functions/v1/payhip-webhook
//
// Verification (per Payhip's docs): the body's `signature` must equal
// sha256(API key) in hex. Secret: PAYHIP_API_KEY. Money arrives in cents;
// `date` is Unix seconds. Payhip retries hourly for 3 hours on anything but 200,
// so a bad signature gets 401 and anything we choose to skip still gets 200.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
async function usdPerUnit(cur: string) {
  if (cur === "USD") return 1;
  const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(cur)}&symbols=USD`);
  const rate = Number((await r.json())?.rates?.USD);
  if (!(rate > 0)) throw new Error(`No ${cur}/USD rate`);
  return rate;
}
const cents = (v: unknown) => (Number(v) || 0) / 100;
const unix = (v: unknown) => (Number(v) > 0 ? new Date(Number(v) * 1000).toISOString() : null);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);
  const key = (Deno.env.get("PAYHIP_API_KEY") || "").trim();
  if (!key) return json({ ok: false, error: "PAYHIP_API_KEY is not set" }, 503);

  let p: Obj;
  try { p = await req.json(); } catch { return json({ ok: false, error: "Body must be JSON." }, 400); }
  if (!sameText(String(p.signature || "").toLowerCase(), await sha256Hex(key))) return json({ ok: false, error: "Bad signature." }, 401);

  const type = String(p.type || "");
  if (type !== "paid" && type !== "refunded") return json({ ok: true, skipped: type || "unknown event" });
  const id = String(p.id || "").slice(0, 200);
  if (!id) return json({ ok: true, skipped: "no order id" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  if (type === "refunded") {
    const up = await admin.from("platform_sales").update({ status: "refunded", updated_at: new Date().toISOString() })
      .eq("platform", "payhip").eq("external_id", id).select("id");
    // A refund for an order we never saw: record it as a refunded row so the history is complete.
    if (!up.error && (up.data || []).length) return json({ ok: true, refunded: id });
  }

  const currency = String(p.currency || "USD").toUpperCase();
  const gross = cents(type === "refunded" && p.price == null ? p.amount_refunded : p.price);
  const fees = cents(p.stripe_fee) + cents(p.paypal_fee) + cents(p.payhip_fee);
  const net = Math.max(0, gross - fees);
  let perUnit = 1;
  try { perUnit = await usdPerUnit(currency); } catch (e) { return json({ ok: false, error: (e as Error).message }, 500); }

  const items: Obj[] = Array.isArray(p.items) ? p.items : [];
  const names = items.map((i) => String(i.product_name || "")).filter(Boolean);
  const qty = items.reduce((s, i) => s + (Number(i.quantity) || 1), 0) || 1;
  let productId: string | null = null;
  if (names.length === 1 && qty === 1) {
    const { data: prods } = await admin.from("products").select("id, title").limit(5000);
    const hit = (prods || []).filter((x: Obj) => norm(x.title) === norm(names[0]));
    if (hit.length === 1) productId = hit[0].id;
  }

  const row = {
    platform: "payhip", source: "api", external_id: id,
    sold_at: unix(p.date) || unix(p.date_created) || new Date().toISOString(),
    product_id: productId,
    product_name: (names.join(", ") || "Payhip order").slice(0, 300),
    currency, amount: gross, amount_usd: Math.round(gross * perUnit * 10000) / 10000,
    net_amount: net, net_usd: Math.round(net * perUnit * 10000) / 10000,
    quantity: qty, buyer_name: p.email ? String(p.email).slice(0, 200) : null,
    status: type === "refunded" ? "refunded" : "paid",
    raw: { payment_type: p.payment_type || null, vat_applied: !!p.vat_applied, is_gift: !!p.is_gift, items: items.map((i) => ({ id: i.product_id, key: i.product_key, qty: i.quantity, on_sale: i.on_sale, coupon: i.used_coupon })) },
    updated_at: new Date().toISOString(),
  };
  const up = await admin.from("platform_sales").upsert(row, { onConflict: "platform,external_id" });
  if (up.error) return json({ ok: false, error: up.error.message }, 500); // non-200 makes Payhip retry
  return json({ ok: true, order: id, status: row.status });
});
