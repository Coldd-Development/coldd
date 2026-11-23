// supabase/functions/clearlydev-sync/index.ts
//
// Background ClearlyDev sync: reads the vendor orders API every few minutes and
// writes each completed order to public.platform_sales (platform 'clearlydev'),
// so ClearlyDev sales count on the admin dashboard without anyone opening
// ClearlyDev. Refunded orders are marked refunded; failed ones are skipped.
// The ClearlyDev dashboard userscript does the same when the dashboard is open;
// both key on the ClearlyDev order number, so an order is always one row.
//
//   supabase functions deploy clearlydev-sync --no-verify-jwt
//   cron: clearlydev-sync, every 5 minutes, POST {"action":"sync"} with x-cron-secret
//
// Auth: the shared x-cron-secret (CRON_SECRET), or a signed-in admin.
// Secret: CLEARLYDEV_COOKIE = the Cookie header the ClearlyDev dashboard sends to
// api.clearlydev.com (copied from DevTools). Used only for the read-only orders
// list below; never logged, never returned.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const API = "https://api.clearlydev.com/api/v1/vendor/orders";
const LIMIT = 100;
const MAX_PAGES = 60;
const OVERLAP_MS = 3 * 86400000;
const BUDGET_MS = 110000;

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "https://coldd.dev",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
      "Content-Type": "application/json",
    },
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

async function alert(text: string) {
  const hook = Deno.env.get("ROBLOX_ALERT_WEBHOOK_URL");
  if (!hook) return;
  try {
    await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `:warning: ${text}` }) });
  } catch (_) { /* alert is best effort */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const body = await req.json().catch(() => ({}));
  if (String(body.action || "sync") !== "sync") return json({ ok: false, error: "Unknown action." }, 400);

  const cronSecret = Deno.env.get("CRON_SECRET") || "";
  if (!(cronSecret && req.headers.get("x-cron-secret") === cronSecret)) {
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ ok: false, error: "Please sign in." }, 401);
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", u.user.id).single();
    if (!prof?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
  }

  const { data: prev } = await admin.from("platform_sync_state").select("*").eq("platform", "clearlydev").maybeSingle();
  async function saveState(patch: Obj) {
    await admin.from("platform_sync_state").upsert({ platform: "clearlydev", last_run_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...patch });
  }
  const cookie = (Deno.env.get("CLEARLYDEV_COOKIE") || "").trim().replace(/^cookie:\s*/i, "");
  if (!cookie) {
    await saveState({ last_error: "CLEARLYDEV_COOKIE is not set", cookie_ok: null });
    return json({ ok: true, configured: false });
  }

  const { data: newestRow } = await admin.from("platform_sales").select("sold_at").eq("platform", "clearlydev").order("sold_at", { ascending: false }).limit(1).maybeSingle();
  const cutoff = newestRow?.sold_at ? new Date(newestRow.sold_at).getTime() - OVERLAP_MS : 0;
  const deadline = Date.now() + BUDGET_MS;

  const orders: Obj[] = [];
  let error = "", cookieOk: boolean | null = true, page = 1, pages = 1;
  try {
    while (page <= Math.min(pages, MAX_PAGES) && Date.now() < deadline) {
      const res = await fetch(`${API}?page=${page}&limit=${LIMIT}`, {
        headers: { Cookie: cookie, Accept: "application/json", Origin: "https://dashboard.clearlydev.com", Referer: "https://dashboard.clearlydev.com/orders" },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 401 || res.status === 403) { cookieOk = false; throw new Error(`ClearlyDev rejected the cookie (${res.status})`); }
      if (res.status === 429) { await sleep(3000); continue; }
      if (!res.ok) throw new Error(`ClearlyDev returned ${res.status}`);
      const j = await res.json();
      if (j?.success === false) { cookieOk = false; throw new Error("ClearlyDev said the session is not valid"); }
      const list: Obj[] = j?.data?.orders || [];
      pages = Number(j?.data?.pagination?.pages) || 1;
      orders.push(...list);
      const oldest = list.reduce((m, o) => Math.min(m, Date.parse(o.created_at) || Infinity), Infinity);
      if (cutoff && oldest < cutoff) break;
      page++;
      await sleep(300);
    }
  } catch (e) {
    error = (e as Error).message;
  }

  let written = 0;
  const keep = orders.filter((o) => o.status === "completed" || o.status === "refunded");
  if (keep.length) {
    const byTitle = new Map<string, string>();
    const { data: prods } = await admin.from("products").select("id, title").limit(5000);
    (prods || []).forEach((p: Obj) => { const k = norm(p.title); if (k && !byTitle.has(k)) byTitle.set(k, p.id); });
    const seen = new Set<string>();
    const payload = keep.filter((o) => { const k = String(o.order_id); if (seen.has(k)) return false; seen.add(k); return true; }).map((o) => {
      const names: string[] = Array.isArray(o.products) ? o.products.map(String) : [];
      const qty = Math.max(1, Number(o.item_count) || names.length || 1);
      const amount = Math.round((Number(o.vendor_amount) || 0) * 10000) / 10000;
      return {
        platform: "clearlydev", source: "api", external_id: String(o.order_id),
        sold_at: new Date(o.created_at).toISOString(),
        product_id: names.length === 1 && qty === 1 ? byTitle.get(norm(names[0])) || null : null,
        product_name: (names.join(", ") || "ClearlyDev order").slice(0, 300),
        currency: "USD", amount, amount_usd: amount, quantity: qty,
        status: o.status === "refunded" || o.has_refunds ? "refunded" : "paid",
        updated_at: new Date().toISOString(),
      };
    });
    for (let i = 0; i < payload.length; i += 500) {
      const up = await admin.from("platform_sales").upsert(payload.slice(i, i + 500), { onConflict: "platform,external_id" });
      if (up.error) { error = error || "Could not save: " + up.error.message; break; }
      written += Math.min(500, payload.length - i);
    }
  }

  if (cookieOk === false && prev?.cookie_ok !== false) {
    await alert("ClearlyDev sync cookie (CLEARLYDEV_COOKIE) was rejected. Copy a fresh Cookie header from the ClearlyDev dashboard into Supabase secrets.");
  }
  const newest = keep.reduce((m, o) => { const t = new Date(o.created_at).toISOString(); return t > m ? t : m; }, prev?.newest_sale_at || "");
  await saveState({
    cookie_ok: cookieOk, last_error: error || null, last_written: written,
    ...(error ? {} : { last_ok_at: new Date().toISOString() }),
    ...(newest ? { newest_sale_at: newest } : {}),
  });
  return json({ ok: !error, read: orders.length, written, error: error || undefined });
});
