// supabase/functions/get-referral-stats/index.ts
//
// Deploy with:
//   supabase functions deploy get-referral-stats
//
// Returns the caller's own referral performance. Referrals are per-product
// only (see _shared/referrals.ts) - an order counts only if it's paid AND
// its ref_product_slug actually matches one of its own order_items, and
// the commission is 20% of just that matching line item, never the whole
// order.
//
// Body: {} (auth only)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { REFERRAL_RATE } from "../_shared/referrals.ts";

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

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const uid = userData.user.id;

    const { data: me } = await admin.from("profiles").select("referral_code").eq("id", uid).single();

    const { data: orders } = await admin
      .from("orders")
      .select("id, created_at, ref_product_slug, order_items(product_slug, title, unit_price_usd, qty)")
      .eq("referrer_id", uid)
      .eq("status", "paid")
      .order("created_at", { ascending: false });

    let earnedUsd = 0;
    const recentSales: { product: string; date: string; earned: number }[] = [];
    (orders || []).forEach((o: { id: string; created_at: string; ref_product_slug: string | null; order_items: { product_slug: string; title: string; unit_price_usd: number | null; qty: number }[] }) => {
      const match = (o.order_items || []).find((it) => it.product_slug === o.ref_product_slug);
      if (!match) return; // the referred product isn't actually in this order (e.g. removed before checkout)
      const amount = round2(Number(match.unit_price_usd || 0) * match.qty * REFERRAL_RATE);
      if (amount <= 0) return;
      earnedUsd += amount;
      recentSales.push({ product: match.title, date: o.created_at, earned: amount });
    });

    const { data: payouts } = await admin
      .from("referral_payouts")
      .select("method, amount_usd, amount_robux, status, requested_at, resolved_at")
      .eq("user_id", uid)
      .order("requested_at", { ascending: false });

    let reservedUsd = 0, paidUsd = 0;
    (payouts || []).forEach((p: { method: string; amount_usd: number | null; status: string }) => {
      if (p.status === "denied") return;
      reservedUsd += Number(p.amount_usd || 0);
      if (p.status === "paid") paidUsd += Number(p.amount_usd || 0);
    });

    return json({
      ok: true,
      code: me?.referral_code || null,
      earnedUsd: round2(earnedUsd),
      availableUsd: round2(Math.max(0, earnedUsd - reservedUsd)),
      paidUsd: round2(paidUsd),
      payouts: payouts || [],
      recentSales: recentSales.slice(0, 25),
    });
  } catch (err) {
    console.error("[get-referral-stats] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
