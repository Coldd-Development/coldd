// supabase/functions/public-site-stats/index.ts
//
// Deploy with:
//   supabase functions deploy public-site-stats --no-verify-jwt
//
// Powers the homepage hero stats (product count, purchases, Discord member count)
// with real numbers instead of hardcoded copy. No auth - these are
// aggregate counts safe to expose publicly, same trust level as the
// storefront itself. Discord's own API doesn't send CORS headers for
// browser fetches, so that count is proxied here too (same approach as
// admin-discord-stats, just without the admin gate).
//
// Body: {} (GET or POST, no auth)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = "https://coldd.dev";
const INVITE_CODE = "coldd";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // Purchases on every platform: coldd.dev paid orders (not test orders or free
    // grants), BuiltByBit, the marketplace sales table (Creator Store, ClearlyDev,
    // Payhip, Parcel orders from the Discord purchase log) and Parcel's Robux sales in the
    // group ledger that no Parcel order covers (an order linked to its ledger sale by
    // ledger_ref is counted once, as the order). Game passes are left out: those are
    // coldd.dev Robux orders, already counted with the orders.
    const head = { count: "exact" as const, head: true };
    const [productRes, discordRes, siteRes, bbbRes, psRes, parcelRes, linkedRes] = await Promise.all([
      admin.from("products").select("*", { count: "exact", head: true }).eq("is_active", true),
      fetch(`https://discord.com/api/v10/invites/${INVITE_CODE}?with_counts=true`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      admin.from("orders").select("id", head).eq("status", "paid").eq("is_test", false).neq("source", "granted"),
      admin.from("bbb2_purchases").select("purchase_id", head),
      admin.from("platform_sales").select("id", head).neq("status", "refunded"),
      admin.from("robux_sales").select("id_hash", head).eq("item_type", "DeveloperProduct"),
      admin.from("platform_sales").select("id", head).not("ledger_ref", "is", null),
    ]);
    const parts = [siteRes, bbbRes, psRes, parcelRes, linkedRes];
    const purchaseCount = parts.every((r) => typeof r.count === "number")
      ? (siteRes.count as number) + (bbbRes.count as number) + (psRes.count as number) + Math.max(0, (parcelRes.count as number) - (linkedRes.count as number))
      : null;

    return json({
      ok: true,
      productCount: productRes.count ?? null,
      purchaseCount,
      discordMemberCount: discordRes?.approximate_member_count ?? null,
    });
  } catch (err) {
    console.error("[public-site-stats] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
