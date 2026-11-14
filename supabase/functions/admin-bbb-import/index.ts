// supabase/functions/admin-bbb-import/index.ts
//
// Deploy with:
//   supabase functions deploy admin-bbb-import --no-verify-jwt
//
// Turns BuiltByBit listings into coldd product drafts through the official v2 API only:
// GET /v2/resources/creator/resources?resource_ids=..&with=Description,Category. Nothing here
// loads a BuiltByBit web page; the only other requests are for the image URLs the API returns.
//
//   fetch  { resource_ids: [135721, ...] }
//          The listings as the API returns them (title, summary, description, price, images,
//          YouTube ids) plus the Robux price, a "- " bullet draft of the long description and
//          any coldd product that already has the same title. No writes.
//   import { items: [{ resource_id, cat, subcat?, title?, description?, long_description?, force? }] }
//          One INACTIVE draft per listing (is_active=false): cover + gallery copied to the CDN
//          (media/<slug>/thumbnails|gallery), price = BuiltByBit list price, Robux from the DevEx
//          ladder (same formula as admin.js), YouTube demo as the video, BuiltByBit marked live
//          on the Marketplaces page, link saved in bbb_imports. A listing that is already in
//          bbb_imports is skipped; one whose title matches an existing product is skipped unless
//          force is set. Returns what each draft still needs before it can go live.
//
// Auth: an admin's session, or the shared x-cron-secret. Secret: BUILTBYBIT_API_TOKEN.
// Requests to BuiltByBit are spaced (MIN_GAP_MS) and a 429 backs off.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cdnEnabled, cdnPublicUrl, cdnSignedUrl } from "../_shared/cdn.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const V2 = "https://api.builtbybit.com";
const MIN_GAP_MS = 500;
const MAX_ATTEMPTS = 4;
const BUDGET_MS = 110000;
const IDS_PER_REQUEST = 50;
const MAX_ITEMS = 25;
const MAX_GALLERY = 15;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_GAP_MS = 1000;
const DEVEX_USD_PER_ROBUX = 0.0038; // same as admin.js
const PLACEHOLDER = "_shared/placeholder.zip";
// Same labels and pages as window.__CATEGORIES in catalog.js
const CATEGORIES: Record<string, string> = {
  "Finished Games & Templates": "/shop", "Maps": "/shop", "Scripts & UI": "/shop", "Graphics": "/shop",
  "Buildings": "/shop", "Assets": "/shop", "Uniforms & Gear": "/shop", "Boats": "/shop", "Weapons": "/shop",
  "Vehicles": "/shop", "Animations & VFX": "/shop",
};

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

let DEADLINE = Infinity;
let NEXT_SLOT = 0;
let COOLDOWN_UNTIL = 0;
const overBudget = (reserveMs = 0) => Date.now() + reserveMs > DEADLINE;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const slugify = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const robuxFor = (usd: number) => (usd > 0 ? Math.ceil((usd / DEVEX_USD_PER_ROBUX) / 100) * 100 : null);

function decodeEntities(s: string) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
// BBCode / HTML to plain text. Media, images and attachments are dropped, link text is kept.
function plain(src: string): string {
  return decodeEntities(String(src ?? "")
    .replace(/\r/g, "")
    .replace(/\[(img|media|attach)[^\]]*\][\s\S]*?\[\/\1\]/gi, "")
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, "$1")
    .replace(/<(img|iframe)[^>]*>/gi, "")
    .replace(/<li[^>]*>/gi, "\n[*]").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h\d|li|ul|ol)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/\[\*\]/g, "\n• ")
    .replace(/\[(?:\/)?[a-z]+(?:=[^\]]*)?\]/gi, " "))
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
}
// A first "- " bullet draft of the long description (one bullet per line / list item).
function bullets(text: string): string {
  return text.split("\n")
    .map((l) => l.replace(/^[\s•\-*▪►➤✓✔✅>]+/u, "").trim())
    .filter((l) => l.length > 1)
    .map((l) => "- " + l)
    .join("\n").slice(0, 8000);
}

const YT_RE = /(?:\[media=youtube\]\s*|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^\s\]"'<>]*?&(?:amp;)?)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/|(?:img|i\d?)\.youtube\.com\/vi(?:_webp)?\/|i\.ytimg\.com\/vi(?:_webp)?\/)([A-Za-z0-9_-]{11})/gi;
const YT_THUMB = /(?:img\.youtube\.com|i\d?\.ytimg\.com|i\d?\.youtube\.com)\/vi/i;
const https = (u: string) => u.replace(/^http:\/\//i, "https://");
// Same image regardless of size preset / query string.
const imageKey = (u: string) => https(u).replace(/[?#].*$/, "").replace(/\/+$/, "");
// The API hands out attachment links with a card-size preset; the bare link is the full image.
const fullSize = (u: string) => {
  try {
    const x = new URL(u);
    x.searchParams.delete("preset");
    return x.toString().replace(/\?$/, "");
  } catch { return u; }
};
function youtubeIds(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(YT_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

async function v2(token: string, path: string): Promise<Obj> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (overBudget()) throw new Error("Ran out of time.");
    const pause = Math.max(COOLDOWN_UNTIL, NEXT_SLOT) - Date.now();
    if (pause > 0) await sleep(pause);
    NEXT_SLOT = Date.now() + MIN_GAP_MS;
    let res: Response;
    try {
      res = await fetch(V2 + path, {
        headers: { Authorization: `Private ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error("BuiltByBit did not answer in time.");
    }
    if (res.status === 429) {
      const hinted = Number(res.headers.get("Retry-After") ?? "0") * 1000;
      COOLDOWN_UNTIL = Date.now() + Math.min(15000, Math.max(hinted, 1000 * 2 ** attempt));
      console.warn("[admin-bbb-import] 429, cooling down");
      continue;
    }
    const text = await res.text();
    let data: Obj = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
    if (!res.ok || data?.result === "error") {
      throw new Error(String(data?.error?.message || data?.message || `BuiltByBit returned ${res.status}.`));
    }
    return data;
  }
  throw new Error("BuiltByBit rate limit hit.");
}

async function fetchListings(token: string, ids: number[]): Promise<Map<number, Obj>> {
  const out = new Map<number, Obj>();
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + IDS_PER_REQUEST);
    const d = await v2(token, `/v2/resources/creator/resources?resource_ids=${chunk.join(",")}&with=Description,Category&per_page=100`);
    const rows: Obj[] = Array.isArray(d?.data?.resources) ? d.data.resources : [];
    for (const r of rows) {
      const id = num(r.resource_id);
      if (chunk.includes(id)) out.set(id, r);
    }
  }
  return out;
}

function listing(r: Obj) {
  const bbcode = String(r.Description?.bbcode ?? "");
  const html = String(r.Description?.html ?? "");
  const carousel: string[] = (Array.isArray(r.carousel_image_urls) ? r.carousel_image_urls : [])
    .filter((u: unknown) => typeof u === "string" && /^https?:\/\//i.test(u)).map(https);
  const yt = youtubeIds([bbcode, html, ...carousel].join("\n"));
  const cover = typeof r.cover_image_url === "string" && r.cover_image_url ? https(r.cover_image_url) : null;
  // The cover is the product page's first slide already, so the gallery leaves it out.
  const seen = new Set<string>(cover ? [imageKey(cover)] : []);
  const gallery = carousel.filter((u) => {
    if (YT_THUMB.test(u) || seen.has(imageKey(u))) return false;
    seen.add(imageKey(u));
    return true;
  });
  const text = plain(bbcode || html);
  const price = r.ListPrice ? num(r.ListPrice.value) : 0;
  return {
    resource_id: num(r.resource_id),
    title: String(r.title ?? "").trim(),
    summary: String(r.summary ?? "").trim(),
    url: r.url ?? null,
    bbb_category: r.Category?.title ?? null,
    currency: r.ListPrice?.currency ?? null,
    list_price: price,
    final_price: r.FinalPrice ? num(r.FinalPrice.value) : null,
    robux_price: robuxFor(price),
    cover,
    gallery,
    youtube: yt,
    video: yt.length ? `https://www.youtube.com/embed/${yt[0]}` : null,
    version: r.LatestVersion?.version_string ?? null,
    purchases: r.purchases ?? null,
    description_text: text.slice(0, 12000),
    bullets_draft: bullets(text),
    has_description: !!(bbcode || html),
    has_category: !!r.Category,
  };
}

// Identify the image from its first bytes (upload.php checks the bytes match the extension).
function sniff(b: Uint8Array): { ext: string; mime: string } | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: "gif", mime: "image/gif" };
  const at = (o: number, s: string) => s.split("").every((c, i) => b[o + i] === c.charCodeAt(0));
  if (at(0, "RIFF") && at(8, "WEBP")) return { ext: "webp", mime: "image/webp" };
  if (at(4, "ftyp") && (at(8, "avif") || at(8, "avis"))) return { ext: "avif", mime: "image/avif" };
  return null;
}

// Copies one image the API pointed at onto the CDN and returns its public URL.
// Image requests are spaced like the API ones: they go to builtbybit.com itself.
let NEXT_IMAGE_SLOT = 0;
async function getImage(url: string): Promise<{ bytes: Uint8Array; kind: { ext: string; mime: string } }> {
  const wait = NEXT_IMAGE_SLOT - Date.now();
  if (wait > 0) await sleep(wait);
  NEXT_IMAGE_SLOT = Date.now() + IMAGE_GAP_MS;
  const res = await fetch(url, { headers: { Accept: "image/*" }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`image returned ${res.status}`); }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image is over 25 MB");
  const kind = sniff(bytes);
  if (!kind) throw new Error("not a jpg/png/gif/webp/avif image");
  return { bytes, kind };
}

// Copies one image the API pointed at onto the CDN (full size when it can) and returns its public URL.
async function copyImage(admin: ReturnType<typeof createClient>, url: string, slug: string, sub: "thumbnails" | "gallery", uploadedBy: string | null) {
  const full = fullSize(url);
  let got: { bytes: Uint8Array; kind: { ext: string; mime: string } };
  try { got = await getImage(full); }
  catch (e) { if (full === url) throw e; got = await getImage(url); }
  const { bytes, kind } = got;
  // Attachment links end in a slash: /attachments/image_2026-11-02_155721703-png.1609463/
  const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "image").replace(/\.[a-z0-9]+$/i, "");
  const base = slugify(last).replace(/-(png|jpe?g|gif|webp|avif)$/, "").slice(0, 60) || "image";
  const cdnPath = `media/${slug}/${sub}/${crypto.randomUUID().slice(0, 8)}-${base}.${kind.ext}`;
  const publicUrl = cdnPublicUrl(cdnPath);
  // Ledger first, same as admin-get-upload-url, so the file is on record even if the save fails.
  const { error: ledgerErr } = await admin.from("storage_uploads").upsert({
    stored_path: publicUrl, kind: sub === "thumbnails" ? "thumbnail" : "gallery", product_slug: slug,
    original_name: `${base}.${kind.ext}`, uploaded_by: uploadedBy,
  }, { onConflict: "stored_path" });
  if (ledgerErr) console.error("[admin-bbb-import] could not record upload:", ledgerErr.message);
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: kind.mime }), `${base}.${kind.ext}`);
  const up = await fetch(await cdnSignedUrl("upload", cdnPath, { maxBytes: 100 * 1024 * 1024 }), {
    method: "POST", body: fd, signal: AbortSignal.timeout(60000),
  });
  const d = await up.json().catch(() => ({}));
  if (!up.ok || d?.ok === false) throw new Error(String(d?.error || `CDN returned ${up.status}`));
  return publicUrl;
}

async function uniqueSlug(admin: ReturnType<typeof createClient>, base: string) {
  let slug = base || "product";
  let n = 2;
  for (;;) {
    const { data } = await admin.from("products").select("id").eq("slug", slug).limit(1);
    if (!data || data.length === 0) return slug;
    slug = `${base}-${n++}`;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    let userId: string | null = null;
    const cronSecret = Deno.env.get("CRON_SECRET") || "";
    const isCron = cronSecret.length > 0 && req.headers.get("x-cron-secret") === cronSecret;
    if (!isCron) {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) return json({ ok: false, error: "Please sign in." }, 401);
      const { data: profile } = await admin.from("profiles").select("is_admin").eq("id", userData.user.id).single();
      if (!profile?.is_admin) return json({ ok: false, error: "Admin access required." }, 403);
      userId = userData.user.id;
    }

    const token = Deno.env.get("BUILTBYBIT_API_TOKEN");
    if (!token) return json({ ok: false, error: "BUILTBYBIT_API_TOKEN is not set." }, 500);
    DEADLINE = Date.now() + BUDGET_MS;

    // Existing products by normalized title, and listings already imported.
    const [{ data: prods }, { data: links }] = await Promise.all([
      admin.from("products").select("id, slug, title, is_active").limit(5000),
      admin.from("bbb_imports").select("resource_id, product_id").limit(5000),
    ]);
    const byTitle = new Map<string, Obj>();
    for (const p of (prods ?? []) as Obj[]) byTitle.set(norm(p.title), p);
    const slugById = new Map<string, string>(((prods ?? []) as Obj[]).map((p) => [p.id, p.slug]));
    const imported = new Map<number, string>(((links ?? []) as Obj[]).map((l) => [Number(l.resource_id), l.product_id]));

    if (action === "fetch") {
      const ids = [...new Set((Array.isArray(body.resource_ids) ? body.resource_ids : []).map((v: unknown) => Math.trunc(num(v))).filter((n: number) => n > 0))] as number[];
      if (!ids.length) return json({ ok: false, error: "Send resource_ids." }, 400);
      if (ids.length > 200) return json({ ok: false, error: "At most 200 ids per call." }, 400);
      const found = await fetchListings(token, ids);
      const listings = ids.map((id) => {
        const r = found.get(id);
        if (!r) return { resource_id: id, found: false };
        const l = listing(r);
        const same = byTitle.get(norm(l.title));
        return {
          found: true, ...l,
          already_imported: imported.has(id) ? slugById.get(imported.get(id)!) ?? imported.get(id) : null,
          existing_product: same ? { slug: same.slug, is_active: same.is_active } : null,
        };
      });
      return json({ ok: true, listings });
    }

    if (action === "import") {
      const items: Obj[] = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ ok: false, error: "Send items." }, 400);
      if (items.length > MAX_ITEMS) return json({ ok: false, error: `At most ${MAX_ITEMS} items per call.` }, 400);
      const bad = items.find((it) => !(num(it.resource_id) > 0) || !CATEGORIES[String(it.cat ?? "")]);
      if (bad) return json({ ok: false, error: `Bad item (resource_id / cat): ${JSON.stringify(bad).slice(0, 200)}` }, 400);
      const useCdn = cdnEnabled();
      const found = await fetchListings(token, items.map((it) => Math.trunc(num(it.resource_id))));
      const results: Obj[] = [];

      for (const it of items) {
        const rid = Math.trunc(num(it.resource_id));
        if (overBudget(25000)) { results.push({ resource_id: rid, ok: false, status: "not_started", reason: "Out of time, send it again." }); continue; }
        if (imported.has(rid)) { results.push({ resource_id: rid, ok: false, status: "skipped", reason: "Already imported", slug: slugById.get(imported.get(rid)!) ?? null }); continue; }
        const r = found.get(rid);
        if (!r) { results.push({ resource_id: rid, ok: false, status: "not_found", reason: "Not returned by /v2/resources/creator/resources (not ours, or removed)" }); continue; }
        const l = listing(r);
        const title = String(it.title || l.title).trim().slice(0, 200);
        const same = byTitle.get(norm(title));
        if (same && it.force !== true) { results.push({ resource_id: rid, ok: false, status: "skipped", reason: "A product with this title already exists", slug: same.slug }); continue; }

        const slug = await uniqueSlug(admin, slugify(title));
        const warnings: string[] = [];
        let image: string | null = null;
        const gallery: string[] = [];
        if (!useCdn) warnings.push("CDN is not configured, images left on BuiltByBit's CDN");
        if (l.cover) {
          try { image = useCdn ? await copyImage(admin, l.cover, slug, "thumbnails", userId) : l.cover; }
          catch (e) { warnings.push("Cover did not copy: " + (e as Error).message); }
        }
        for (const g of l.gallery.slice(0, MAX_GALLERY)) {
          if (overBudget(12000)) { warnings.push("Ran short on time, some gallery images were not copied"); break; }
          try { gallery.push(useCdn ? await copyImage(admin, g, slug, "gallery", userId) : g); }
          catch (e) { warnings.push("Gallery image did not copy: " + (e as Error).message); }
        }
        if (l.gallery.length > MAX_GALLERY) warnings.push(`Only the first ${MAX_GALLERY} of ${l.gallery.length} gallery images were copied`);
        if (!image && gallery.length) { image = gallery[0]; warnings.push("No cover, used the first gallery image"); }

        const price = it.price_usd != null ? Math.max(0, num(it.price_usd)) : l.list_price;
        const row = {
          slug, title,
          price_usd: price,
          robux_price: robuxFor(price),
          resell_available: false,
          image,
          gallery,
          video: l.video ?? "",
          description: String(it.description || l.summary || "").trim().slice(0, 300),
          long_description: String(it.long_description || l.bullets_draft || "").trim().slice(0, 8000),
          cat: String(it.cat),
          subcat: String(it.subcat || "").trim() || null,
          platform: "Roblox",
          page: CATEGORIES[String(it.cat)],
          storage_path: PLACEHOLDER,
          is_active: false,
        };
        const { data: created, error: insErr } = await admin.from("products").insert(row).select("id").single();
        if (insErr || !created) { results.push({ resource_id: rid, ok: false, status: "error", reason: "Could not create product: " + (insErr?.message ?? "unknown") }); continue; }
        const { error: linkErr } = await admin.from("bbb_imports").insert({ resource_id: rid, product_id: created.id, bbb_url: l.url, bbb_title: l.title, imported_by: userId });
        if (linkErr) {
          await admin.from("products").delete().eq("id", created.id);
          results.push({ resource_id: rid, ok: false, status: "error", reason: "Could not save the import link: " + linkErr.message });
          continue;
        }
        imported.set(rid, created.id);
        byTitle.set(norm(title), { id: created.id, slug, title, is_active: false });
        await admin.from("marketplace_listings").upsert({ product_id: created.id, marketplace: "builtbybit", status: "live", synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "product_id,marketplace" });

        const missing = ["Product file", "Legal (licence type, TOS, proof, price floors)", "Resell (on/off + price)"];
        if (!row.video) missing.push("YouTube demo");
        if (!gallery.length) missing.push("Gallery images");
        if (!image) missing.push("Cover image");
        if (!row.subcat) missing.push("Subcategory");
        if (price <= 0) missing.push("Price (free on BuiltByBit)");
        if (l.currency && l.currency !== "USD") warnings.push(`BuiltByBit price is in ${l.currency}, not USD`);
        if (l.youtube.length > 1) warnings.push(`${l.youtube.length} YouTube videos found, used the first`);
        results.push({
          resource_id: rid, ok: true, status: "created", product_id: created.id, slug, title,
          price_usd: row.price_usd, robux_price: row.robux_price, cat: row.cat, subcat: row.subcat,
          image, gallery_count: gallery.length, video: row.video || null, missing, warnings,
        });
      }
      return json({ ok: true, results });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[admin-bbb-import] error:", err);
    return json({ ok: false, error: (err as Error).message || "Server error." }, 500);
  }
});
