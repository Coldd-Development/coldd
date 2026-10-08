// supabase/functions/admin-upsert-product/index.ts
//
// Deploy with:
//   supabase functions deploy admin-upsert-product
//
// No new secrets required - reuses the auto-injected SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY.
//
// Backend for the admin panel's product create/edit form (admin.html +
// admin.js). Creates or updates a row in public.products plus its matching
// public.product_legal row. Gated on profiles.is_admin - this is the real,
// server-side enforcement that the client-side Discord-ID whitelist in
// supabase-init.js can't provide on its own.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { notifyUser } from "../_shared/notify.ts";

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

// Auto-announces a new product launch or a pushed version/update, so the
// admin doesn't have to remember to hand-write a matching Releases entry
// every time. Best-effort - failure here never blocks the product save.
async function autoCreateRelease(
  admin: ReturnType<typeof createClient>,
  opts: { productSlug: string; title: string; summary: string; kind: string; version?: string },
) {
  try {
    const base = (opts.version ? `${opts.productSlug}-${opts.version}` : `${opts.productSlug}-launch`)
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "release";
    const slug = `${base}-${Date.now().toString(36)}`;
    await admin.from("content").insert({
      type: "release",
      slug,
      visible: true,
      data: {
        version: opts.version || "",
        kind: opts.kind,
        title: opts.title,
        date: new Date().toISOString().slice(0, 10),
        affects: [opts.productSlug],
        summary: opts.summary,
        details: "",
      },
    });
  } catch (err) {
    console.error("[admin-upsert-product] auto-release failed (non-blocking):", err);
  }
}

function slugify(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function uniqueSlug(admin: ReturnType<typeof createClient>, base: string, excludeId?: string) {
  let slug = base || "product";
  let n = 2;
  for (;;) {
    let q = admin.from("products").select("id").eq("slug", slug).limit(1);
    if (excludeId) q = q.neq("id", excludeId);
    const { data } = await q;
    if (!data || data.length === 0) return slug;
    slug = `${base}-${n++}`;
  }
}

const LICENSE_TYPES = ["ownership", "resell_plus", "resell_rights", "revenue_share"];

type LegalPayload = {
  tos?: string;
  licenseType?: string;
  revenueSharePct?: number | null;
  revenueSharePaymentPlatform?: string;
  revenueSharePaymentLink?: string;
  proofFiles?: string[];
  devProofFiles?: string[];
  contacts?: { label: string; value: string }[];
  licenseCost?: number;
  licenseCostCurrency?: "usd" | "robux";
  licensePurchasedAt?: string | null;
  minSaleUsd?: number;
  minSaleRobux?: number;
  maxDiscountPct?: number;
  canBeFree?: boolean;
  disallowSales?: boolean;
};

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

    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("is_admin")
      .eq("id", userData.user.id)
      .single();
    if (profileErr || !profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);

    const body = await req.json().catch(() => ({}));
    const id: string | undefined = body.id || undefined;
    const title = String(body.title || "").trim();
    if (!title) return json({ ok: false, error: "Title is required." }, 400);

    // License type + revenue share terms (validated before anything is saved). The revenue
    // share fields are only kept while the type is revenue_share, so a product that switches
    // to another type never leaves stale payout data behind for the future tracker to read.
    const legalIn: LegalPayload = body.legal && typeof body.legal === "object" ? body.legal : {};
    const licenseType = LICENSE_TYPES.includes(String(legalIn.licenseType)) ? String(legalIn.licenseType) : null;
    const isRevShare = licenseType === "revenue_share";
    const revSharePct = isRevShare ? Math.round(Math.min(100, Math.max(0, Number(legalIn.revenueSharePct) || 0)) * 100) / 100 : null;
    if (isRevShare && !(revSharePct && revSharePct > 0)) {
      return json({ ok: false, error: "Enter the revenue share percentage (more than 0, up to 100)." }, 400);
    }

    const platform = body.platform === "Minecraft" ? "Minecraft" : "Roblox";
    const price = Math.max(0, Number(body.price) || 0);
    // Only a real "was" price if it's actually higher than the current one -
    // otherwise this isn't a sale, it's just a number sitting in a field.
    const wasPrice = body.wasPrice != null && Number(body.wasPrice) > price ? Number(body.wasPrice) : null;
    const robuxPrice = body.robuxPrice != null ? Math.max(0, Number(body.robuxPrice) || 0) : 0;

    // Enforce product_legal against the price an admin is trying to set by
    // hand - the same limits every automatic discount path already
    // respects. Uses the legal values coming in with this save (the editor
    // sends product + legal together), falling back to the row on file.
    {
      const lp = body.legal && typeof body.legal === "object" ? body.legal : null;
      let minUsd = 0, minRbx = 0, maxPct = 0, disallow = false, canFree = true, hasLegal = false;
      if (lp) {
        minUsd = Math.max(0, Number(lp.minSaleUsd) || 0);
        minRbx = Math.max(0, Number(lp.minSaleRobux) || 0);
        maxPct = Math.max(0, Math.min(100, Number(lp.maxDiscountPct) || 0));
        disallow = !!lp.disallowSales;
        canFree = !!lp.canBeFree;
        hasLegal = true;
      } else if (id) {
        const { data: row } = await admin
          .from("product_legal")
          .select("min_sale_usd, min_sale_robux, max_discount_pct, disallow_sales, can_be_free")
          .eq("product_id", id)
          .maybeSingle();
        if (row) {
          minUsd = Number(row.min_sale_usd) || 0;
          minRbx = Number(row.min_sale_robux) || 0;
          maxPct = Number(row.max_discount_pct) || 0;
          disallow = !!row.disallow_sales;
          canFree = !!row.can_be_free;
          hasLegal = true;
        }
      }
      if (hasLegal) {
        const onSale = wasPrice != null && wasPrice > price;
        const errs: string[] = [];
        if (onSale && disallow) errs.push('this product is marked "do not discount"');
        if (minUsd > 0 && price > 0 && price < minUsd) errs.push(`the USD price is below the $${minUsd.toFixed(2)} minimum sale price`);
        if (onSale && maxPct > 0 && (1 - price / wasPrice!) * 100 > maxPct + 0.01) {
          errs.push(`that's a ${Math.round((1 - price / wasPrice!) * 100)}% discount, over the ${maxPct}% maximum`);
        }
        if (!canFree && price <= 0) errs.push("this product isn't allowed to be free");
        if (minRbx > 0 && robuxPrice > 0 && robuxPrice < minRbx) errs.push(`the Robux price is below the ${minRbx} minimum`);
        if (errs.length) return json({ ok: false, error: `Can't save - ${errs.join("; ")}. Adjust the price or the product's Legal settings.` }, 400);
      }
    }

    const productFields: Record<string, unknown> = {
      title,
      platform,
      page: platform === "Minecraft" ? "/minecraft" : "/shop",
      price_usd: price,
      was_price: wasPrice,
      priority: !!body.priority,
      featured: !!body.featured,
      featured_order: Math.max(0, Number(body.featuredOrder) || 0),
      cat: body.cat != null ? String(body.cat) : null,
      subcat: body.subcat != null
        ? (String(body.subcat).toLowerCase().split(",").map((v) => v.trim()).filter((v) => /^[a-z0-9-]+$/.test(v)).join(",") || null)
        : null,
      description: body.desc != null ? String(body.desc) : "",
      long_description: body.longDesc != null ? String(body.longDesc) : "",
      image: body.image != null ? String(body.image) : null,
      gallery: Array.isArray(body.gallery) ? body.gallery : [],
      video: body.video != null ? String(body.video) : null,
      resell_available: !!body.resell,
      resell_price_usd: body.resell && body.resellPrice != null ? Number(body.resellPrice) : null,
      resell_robux_price: body.resell && body.resellRobuxPrice != null ? Number(body.resellRobuxPrice) : null,
      robux_price: body.robuxPrice != null ? Number(body.robuxPrice) : null,
      is_active: !!body.visible,
      tech: body.tech && typeof body.tech === "object" ? body.tech : {},
    };
    if (Array.isArray(body.versions)) productFields.versions = body.versions;
    if (typeof body.storagePath === "string" && body.storagePath) productFields.storage_path = body.storagePath;

    // deno-lint-ignore no-explicit-any
    let existingProduct: { versions: any[] | null; slug: string; was_price: number | null } | null = null;
    if (id) {
      const { data } = await admin
        .from("products")
        .select("versions, slug, was_price")
        .eq("id", id)
        .maybeSingle();
      existingProduct = data;
    }

    let productId = id;
    if (id) {
      const { data: updated, error: updateErr } = await admin
        .from("products")
        .update(productFields)
        .eq("id", id)
        .select()
        .single();
      if (updateErr || !updated) return json({ ok: false, error: "Could not update product." }, 500);

      // Newly on sale (wasn't before, is now) - not "still on sale" or
      // "price nudged while already on sale", just the actual transition,
      // so editing an already-discounted product doesn't re-notify anyone
      // on every unrelated save.
      const wasOnSaleBefore = !!(existingProduct && Number(existingProduct.was_price) > 0);
      if (!wasOnSaleBefore && wasPrice != null) {
        const { data: wishlisters } = await admin.from("wishlist_items").select("user_id").eq("product_id", id);
        const pct = Math.round((1 - price / wasPrice) * 100);
        for (const w of wishlisters ?? []) {
          await notifyUser(
            admin,
            w.user_id,
            "An item on your wishlist is on sale",
            `${title} is now ${pct}% off.`,
            `/product?id=${existingProduct?.slug ?? id}`,
          );
        }
      }
    } else {
      const slug = await uniqueSlug(admin, slugify(title));
      const { data: created, error: insertErr } = await admin
        .from("products")
        .insert({ ...productFields, slug })
        .select()
        .single();
      if (insertErr || !created) return json({ ok: false, error: "Could not create product." }, 500);
      productId = created.id;
    }

    const legal: LegalPayload = body.legal && typeof body.legal === "object" ? body.legal : {};
    const legalFields = {
      product_id: productId,
      tos: legal.tos != null ? String(legal.tos) : "",
      license_type: licenseType,
      revenue_share_pct: revSharePct,
      revenue_share_payment_platform: isRevShare ? String(legal.revenueSharePaymentPlatform || "").trim().slice(0, 60) || null : null,
      revenue_share_payment_link: isRevShare ? String(legal.revenueSharePaymentLink || "").trim().slice(0, 300) || null : null,
      proof_files: Array.isArray(legal.proofFiles) ? legal.proofFiles : [],
      dev_proof_files: Array.isArray(legal.devProofFiles) ? legal.devProofFiles : [],
      contacts: Array.isArray(legal.contacts) ? legal.contacts : [],
      license_cost: Math.max(0, Number(legal.licenseCost) || 0),
      license_cost_currency: legal.licenseCostCurrency === "robux" ? "robux" : "usd",
      license_purchased_at: legal.licensePurchasedAt || null,
      min_sale_usd: Math.max(0, Number(legal.minSaleUsd) || 0),
      min_sale_robux: Math.max(0, Number(legal.minSaleRobux) || 0),
      max_discount_pct: Math.max(0, Math.min(100, Number(legal.maxDiscountPct) || 0)),
      can_be_free: !!legal.canBeFree,
      disallow_sales: !!legal.disallowSales,
      updated_at: new Date().toISOString(),
    };
    const { error: legalErr } = await admin.from("product_legal").upsert(legalFields);
    if (legalErr) return json({ ok: false, error: "Product saved, but legal info failed to save." }, 500);

    // Auto-announce: brand-new product launch, or a newly pushed version
    // on an existing one (versions is append-only, so a longer array means
    // a new entry landed at the end).
    if (!id && !!body.visible) {
      const { data: newRow } = await admin.from("products").select("slug").eq("id", productId).single();
      if (newRow?.slug) {
        await autoCreateRelease(admin, {
          productSlug: newRow.slug,
          title: `${title} launches`,
          summary: (productFields.description as string) || `${title} is now available.`,
          kind: "Feature",
        });
      }
    } else if (id && existingProduct && Array.isArray(body.versions)) {
      const oldVersions = existingProduct.versions || [];
      if (body.versions.length > oldVersions.length) {
        const latest = body.versions[body.versions.length - 1];
        await autoCreateRelease(admin, {
          productSlug: existingProduct.slug,
          title: `${title} - ${latest?.version || "update"}`,
          summary: latest?.changelog || `${title} was updated.`,
          kind: "Fix",
          version: latest?.version,
        });
        // Notify everyone who owns this product that a new version landed,
        // unless they've turned product-update notifications off.
        try {
          const { data: ownerItems } = await admin
            .from("order_items")
            .select("orders!inner(user_id, status)")
            .eq("product_slug", existingProduct.slug)
            .eq("orders.status", "paid");
          const ownerIds = [...new Set(
            (ownerItems ?? [])
              .map((r: { orders?: { user_id?: string } }) => r.orders?.user_id)
              .filter((u): u is string => !!u),
          )];
          if (ownerIds.length) {
            const { data: profs } = await admin.from("profiles").select("id, notification_prefs").in("id", ownerIds);
            const prefById = new Map((profs ?? []).map((p: { id: string; notification_prefs: Record<string, unknown> | null }) => [p.id, p.notification_prefs || {}]));
            const changelog = String(latest?.changelog || "").trim();
            const notifBody = (latest?.version ? `${latest.version} - ` : "") + (changelog ? changelog.slice(0, 160) : "A new version is available in your Licenses.");
            for (const uid of ownerIds) {
              const prefs = prefById.get(uid) as Record<string, unknown> | undefined;
              if (prefs && prefs.inAppProductUpdates === false) continue;
              await notifyUser(admin, uid, `${title} was updated`, notifBody, `/product?id=${existingProduct.slug}`);
            }
          }
        } catch (notifyErr) {
          console.error("[admin-upsert-product] owner update notify failed:", notifyErr);
        }
      }
    }

    return json({ ok: true, id: productId });
  } catch (err) {
    console.error("[admin-upsert-product] error:", err);
    return json({ ok: false, error: "Server error." }, 500);
  }
});
