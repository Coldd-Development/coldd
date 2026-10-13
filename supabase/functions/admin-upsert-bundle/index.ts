// supabase/functions/admin-upsert-bundle/index.ts
//
// Deploy with:
//   supabase functions deploy admin-upsert-bundle
//
// Admin CRUD for curated (permanent, public) product bundles. Writes
// bundle_deals rows with source='curated' - see supabase/bundles.sql and
// supabase/addons_bundles.sql. A curated bundle gives bundle_pct off every
// listed product, but only when the whole set is in the cart (item_pct stays
// 0); priceItems() applies it automatically, no token needed.
//
// Every bundle is checked against each product's price limits (min_sale_usd /
// min_sale_robux, max_discount_pct, disallow_sales, can_be_free) before it is
// saved - see _shared/bundles.ts. A bundle that cannot respect them is refused
// here, never silently clamped later.
//
// Body:
//   { action: "list" }
//   { action: "limits", productSlugs: [] }            -> the most discount that set can take
//   { action: "suggest" }                             -> genre-matched bundle ideas
//   { action: "upsert", token?, slug?, title, description?, coverSlug?, image?,
//                       productSlugs: [], discountPct, active? }
//   { action: "delete", token }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  BUNDLE_MAX_PCT,
  BUNDLE_PRODUCT_COLS,
  bundleMaxPct,
  pickCoverSlug,
  suggestBundles,
  validateBundle,
  type BundleProduct,
} from "../_shared/bundles.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";

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

function randToken(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
  return "BNDL-" + s;
}

const slugify = (s: string) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

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
    const { data: profile } = await admin.from("profiles").select("is_admin").eq("id", userData.user.id).single();
    if (!profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");

    if (action === "list") {
      const { data } = await admin.from("bundle_deals")
        .select("token, slug, title, description, cover_slug, image, slugs, bundle_pct, active, created_at")
        .eq("source", "curated").order("created_at", { ascending: false });
      return json({ ok: true, bundles: data ?? [] });
    }

    if (action === "delete") {
      const token = String(body.token || "");
      if (!token) return json({ ok: false, error: "Missing token." }, 400);
      await admin.from("bundle_deals").delete().eq("token", token).eq("source", "curated");
      return json({ ok: true });
    }

    // The most discount a candidate set can take, for the form's live hint.
    if (action === "limits") {
      const slugs = Array.isArray(body.productSlugs)
        ? Array.from(new Set(body.productSlugs.map((s: unknown) => String(s || "").trim()).filter(Boolean)))
        : [];
      if (!slugs.length) return json({ ok: true, maxPct: BUNDLE_MAX_PCT, blockers: [] });
      const { data: found } = await admin.from("products").select(BUNDLE_PRODUCT_COLS).in("slug", slugs).eq("is_active", true);
      const lim = bundleMaxPct((found ?? []) as BundleProduct[]);
      return json({ ok: true, maxPct: lim.maxPct, blockers: lim.blockers });
    }

    if (action === "suggest") {
      const [{ data: prods }, { data: existing }] = await Promise.all([
        admin.from("products").select(BUNDLE_PRODUCT_COLS).eq("is_active", true).limit(5000),
        admin.from("bundle_deals").select("slugs").eq("source", "curated"),
      ]);
      const { suggestions, blocked } = suggestBundles((prods ?? []) as BundleProduct[], (existing ?? []) as { slugs: string[] }[]);
      return json({ ok: true, suggestions, blocked });
    }

    if (action === "upsert") {
      const title = String(body.title || "").trim();
      const description = String(body.description || "").trim();
      const image = String(body.image || "").trim() || null;
      const productSlugs: string[] = Array.isArray(body.productSlugs)
        ? Array.from(new Set(body.productSlugs.map((s: unknown) => String(s || "").trim()).filter(Boolean)))
        : [];
      const discountPct = Math.round(Number(body.discountPct) || 0);
      const active = body.active !== false;
      const slug = slugify(body.slug || title);

      if (!slug || !title) return json({ ok: false, error: "A title is required." }, 400);
      if (title.length > 80) return json({ ok: false, error: "The title is over 80 characters." }, 400);
      if (description.length > 300) return json({ ok: false, error: "The description is over 300 characters." }, 400);

      // Every product must exist and be active.
      const { data: found } = await admin.from("products").select(BUNDLE_PRODUCT_COLS).in("slug", productSlugs).eq("is_active", true);
      const prods = (found ?? []) as BundleProduct[];
      const foundSet = new Set(prods.map((p) => p.slug as string));
      const missing = productSlugs.filter((s) => !foundSet.has(s));
      if (missing.length) return json({ ok: false, error: `Not active products: ${missing.join(", ")}` }, 400);

      // The price-floor gate: refuse any bundle that cannot respect every
      // product's limits at the chosen discount.
      const floorErr = validateBundle(prods, discountPct);
      if (floorErr) return json({ ok: false, error: floorErr }, 400);

      // The cover is the most popular product unless one was picked by hand.
      const requestedCover = String(body.coverSlug || "").trim();
      const coverSlug = requestedCover && productSlugs.includes(requestedCover) ? requestedCover : pickCoverSlug(prods);

      const row = {
        slugs: productSlugs,
        item_pct: 0,
        bundle_pct: discountPct,
        source: "curated" as const,
        expires_at: null,
        user_id: null,
        email: null,
        title,
        description: description || null,
        cover_slug: coverSlug,
        image,
        slug,
        active,
      };

      const token = body.token ? String(body.token) : null;
      if (token) {
        const { error } = await admin.from("bundle_deals").update(row).eq("token", token).eq("source", "curated");
        if (error) {
          if (/duplicate key/i.test(error.message)) return json({ ok: false, error: "A bundle with that name already exists." }, 400);
          return json({ ok: false, error: error.message }, 500);
        }
        return json({ ok: true, token });
      }
      // New: retry on the rare token collision.
      for (let i = 0; i < 4; i++) {
        const t = randToken();
        const { error } = await admin.from("bundle_deals").insert({ ...row, token: t });
        if (!error) return json({ ok: true, token: t });
        if (/duplicate key/i.test(error.message) && /slug/i.test(error.message)) {
          return json({ ok: false, error: "A bundle with that name already exists." }, 400);
        }
      }
      return json({ ok: false, error: "Could not create the bundle." }, 500);
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[admin-upsert-bundle] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
