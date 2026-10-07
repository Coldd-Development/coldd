// supabase/functions/get-set-deal/index.ts
//
// Deploy with:
//   supabase functions deploy get-set-deal
//
// "Complete the collection": finds a product subcategory where the signed-in
// buyer already owns 2+ items and at least one is still missing, mints a
// bundle_deals token for the missing ones, and returns them so the
// dashboard can offer "get the rest at a discount". priceItems() applies
// the discount at checkout when every returned slug is in the cart.
//
// Body: {} (uses the caller's own paid orders)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mintBundleDeal } from "../_shared/discount_codes.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const ITEM_PCT = 12;
const BUNDLE_PCT = 6;   // extra, when the whole remainder is bought together
const EXPIRES_DAYS = 5;
const MIN_OWNED = 2;

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
function humanize(s: string): string {
  return String(s || "").replace(/-/g, " ").replace(/\b\w+/g, (w) => /^(vfx|ui|scpf|npc|gui|fps|rpg|ugc|2d|3d)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    // Products this buyer already owns (any paid order).
    const { data: ownedRows } = await admin
      .from("order_items")
      .select("product_id, orders!inner(user_id, status)")
      .eq("orders.user_id", userData.user.id)
      .eq("orders.status", "paid");
    const ownedIds = new Set((ownedRows ?? []).map((r: { product_id: string }) => r.product_id));
    if (ownedIds.size < MIN_OWNED) return json({ ok: true, deal: null });

    // Every active product with a subcategory, so we can size each "set".
    const { data: prods } = await admin
      .from("products")
      .select("id, slug, title, price_usd, image, subcat, cat, platform")
      .eq("is_active", true)
      .not("subcat", "is", null);

    // deno-lint-ignore no-explicit-any
    const bySub = new Map<string, { sub: string; items: any[] }>();
    for (const p of prods ?? []) {
      if (!p.subcat) continue;
      // A product can belong to several sub-categories (comma-separated).
      for (const sub of String(p.subcat).split(",").map((v: string) => v.trim()).filter(Boolean)) {
        const key = `${p.platform}::${sub}`;
        if (!bySub.has(key)) bySub.set(key, { sub, items: [] });
        bySub.get(key)!.items.push(p);
      }
    }

    // Best set = most already-owned, then most still-missing.
    // deno-lint-ignore no-explicit-any
    let best: { label: string; owned: number; missing: any[] } | null = null;
    for (const [, entry] of bySub) {
      const items = entry.items;
      if (items.length < 3) continue; // not really a "collection"
      const ownedN = items.filter((p) => ownedIds.has(p.id)).length;
      const missing = items.filter((p) => !ownedIds.has(p.id));
      if (ownedN < MIN_OWNED || !missing.length) continue;
      if (!best || ownedN > best.owned || (ownedN === best.owned && missing.length < best.missing.length)) {
        best = { label: humanize(entry.sub), owned: ownedN, missing };
      }
    }
    if (!best) return json({ ok: true, deal: null });

    const slugs = best.missing.map((p) => p.slug);
    const token = await mintBundleDeal(admin, {
      slugs,
      itemPct: ITEM_PCT,
      bundlePct: BUNDLE_PCT,
      source: "set_completion",
      userId: userData.user.id,
      expiresInDays: EXPIRES_DAYS,
    });
    if (!token) return json({ ok: true, deal: null });

    return json({
      ok: true,
      deal: {
        label: best.label,
        ownedCount: best.owned,
        totalCount: best.owned + best.missing.length,
        itemPct: ITEM_PCT,
        bundlePct: ITEM_PCT + BUNDLE_PCT,
        token,
        items: best.missing.map((p) => ({
          slug: p.slug, title: p.title, priceUsd: Number(p.price_usd), image: p.image, cat: p.cat,
        })),
      },
    });
  } catch (err) {
    console.error("[get-set-deal] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
