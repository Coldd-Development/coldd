// supabase/functions/admin-bbb-import/index.ts
//
// Deploy with:
//   supabase functions deploy admin-bbb-import --no-verify-jwt
//
// Turns marketplace listings into coldd product drafts.
//
// BuiltByBit comes through the official v2 API only: GET /v2/resources/creator/resources
// ?resource_ids=..&with=Description,Category. Nothing here loads a BuiltByBit web page; the only
// other requests are for the image URLs the API returns (spaced 1s apart per call).
// ClearlyDev has no API, so those items arrive already read (by the admin's browser) in
// item.external and only their images are downloaded here.
//
//   fetch  { resource_ids: [135721, ...], raw?: true }
//          The BuiltByBit listings as the API returns them plus the Robux price, a "- " bullet
//          draft of the long description and any coldd product with the same title. No writes.
//   import { items: [...] } (max 25 per call)
//          One INACTIVE draft per item (is_active=false): cover + gallery copied to the CDN,
//          price = marketplace price unless price_usd is given, Robux from the DevEx ladder
//          (same formula as admin.js), YouTube demo when the description has one.
//          Item shape:
//            BuiltByBit: { resource_id, cat, ... }
//            ClearlyDev: { source: "clearlydev", external: { url, title, price_usd, text, tags, yt[], cover, gallery[] }, cat, ... }
//            optional:   subcat, title, description, long_description, price_usd (0 = free), force,
//                        legal_from (slug of a product whose legal data is copied),
//                        legal_license_types (override on the copy),
//                        tasks: [{ marketplace, title }]
//          "Uploaded on" marketplaces are marked live: BuiltByBit for a BuiltByBit link;
//          BuiltByBit AND ClearlyDev for a ClearlyDev-only link.
//          A BuiltByBit listing already in bbb_imports is skipped; a title that already exists is
//          skipped unless force is set.
//
// Auth: an admin's session, or the shared x-cron-secret. Secret: BUILTBYBIT_API_TOKEN.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cdnDownloadUrl, cdnEnabled, cdnPublicUrl, cdnSignedUrl } from "../_shared/cdn.ts";
import { storedFileExists } from "../_shared/files.ts";

const ALLOWED_ORIGIN = "https://coldd.dev";
const V2 = "https://api.builtbybit.com";
const MIN_GAP_MS = 500;
const MAX_ATTEMPTS = 4;
const BUDGET_MS = 110000;
const IDS_PER_REQUEST = 50;
const MAX_ITEMS = 25;
const MAX_GALLERY = 15;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_GAP: Record<string, number> = { builtbybit: 1000, clearlydev: 150 };
const DEVEX_USD_PER_ROBUX = 0.0038; // same as admin.js
const PLACEHOLDER = "_shared/placeholder.zip";
// Same labels and pages as window.__CATEGORIES in catalog.js
const CATEGORIES: Record<string, string> = {
  "Finished Games & Templates": "/shop", "Maps": "/shop", "Scripts & UI": "/shop", "Graphics": "/shop",
  "Buildings": "/shop", "Assets": "/shop", "Uniforms & Gear": "/shop", "Boats": "/shop", "Weapons": "/shop",
  "Vehicles": "/shop", "Animations & VFX": "/shop",
};
const TASK_MARKETS = ["builtbybit", "clearlydev", "parcel", "creatorstore", "site"];

// Subcategory guesses (keys of window.__SUBCAT_LABELS), first matches win, at most 3.
const SUBCAT_RULES: Record<string, Array<[string, RegExp]>> = {
  "Buildings": [
    ["scpf", /\b(scp|foundation|containment|facility)\b/],
    ["sci-fi", /sci-?fi|futur|colony|cyber|alien|outpost/],
    ["military", /military|army|barracks|bunker|armory|armoury|hangar|hanger|warehouse|killhouse|soldier/],
    ["government", /police|sheriff|fire (station|department)|post office|court|city hall|embassy|headquarters|commission|palace|istana|ministry|parliament|government|kpk|park service/],
    ["medieval", /medieval|castle|\bfort\b|roman|tavern|tower of london|maiden/],
    ["anime-fantasy", /anime|fantasy|japanese|dojo|temple|pagoda/],
    ["building-packs", /\bpack\b|\bkit\b|collection|bundle/],
    ["filler", /filler/],
    ["interior-only", /interior only|\broom\b|basement|cafeteria|laborator/],
    ["houses-residential", /house|villa|mansion|flats?\b|apartment|dormitor|cottage|cabin|\bhome\b|residen|loft|tongkonan|bungalow/],
    ["stores-commercial", /store|shop|market|\bmart\b|cafe|restaurant|dealership|bank|mall|shopping|food|stall|repair|car wash|motel|hotel|office|supermarket|convenience|warteg|burger|pizza|walmart|dollar|clothing|minimarket/],
    ["roleplay", /roleplay|school|hospital|mosque|clinic|stadium|station/],
  ],
};
function guessSubcat(cat: string, hay: string): string | null {
  const rules = SUBCAT_RULES[cat];
  if (!rules) return null;
  const h = hay.toLowerCase();
  const out: string[] = [];
  for (const [key, re] of rules) if (re.test(h) && !out.includes(key)) out.push(key);
  if (!out.length) out.push("roleplay");
  return out.slice(0, 3).join(",");
}

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
// Headings ("Product Features:"), links and Discord invites are left out.
function bullets(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.replace(/^[\s•\-*▪►➤✓✔✅>]+/u, "").trim();
    if (l.length < 2) continue;
    if (/^(product |key |main )?(features?|includes?|included|details|description|specs?|specifications|what'?s included|contents)\s*:?$/i.test(l)) continue;
    if (/:\s*$/.test(l) && l.length < 40) continue;
    if (/https?:\/\/|discord\.gg|show ?case\s*>>/i.test(l)) continue;
    const b = "- " + l.slice(0, 300);
    if (!out.includes(b)) out.push(b);
  }
  return out.join("\n").slice(0, 8000);
}
function shortDesc(summary: string, bulletText: string, title: string): string {
  if (summary) return summary.slice(0, 300);
  const parts = bulletText.split("\n").map((s) => s.replace(/^- /, "")).slice(0, 3);
  return (parts.join(", ") || title).slice(0, 300);
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
// Cover first (it is the product page's first slide already), gallery without it or duplicates.
function splitImages(coverIn: unknown, galleryIn: unknown[]): { cover: string | null; gallery: string[] } {
  const cover = typeof coverIn === "string" && coverIn ? https(coverIn) : null;
  const seen = new Set<string>(cover ? [imageKey(cover)] : []);
  const gallery = galleryIn
    .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)).map(https)
    .filter((u) => {
      if (YT_THUMB.test(u) || seen.has(imageKey(u))) return false;
      seen.add(imageKey(u));
      return true;
    });
  return { cover, gallery };
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
  const carousel: unknown[] = Array.isArray(r.carousel_image_urls) ? r.carousel_image_urls : [];
  const yt = youtubeIds([bbcode, html, ...carousel.filter((u): u is string => typeof u === "string")].join("\n"));
  const { cover, gallery } = splitImages(r.cover_image_url, carousel);
  const text = plain(bbcode || html);
  const price = r.ListPrice ? num(r.ListPrice.value) : 0;
  return {
    source: "builtbybit",
    resource_id: num(r.resource_id),
    title: String(r.title ?? "").trim(),
    summary: String(r.summary ?? "").trim(),
    url: r.url ?? null,
    bbb_category: r.Category?.title ?? null,
    tags: "",
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

// A ClearlyDev page, already read by the admin's browser, in the same shape as listing().
function fromClearly(e: Obj) {
  const text = String(e.text ?? "");
  const yt = (Array.isArray(e.yt) ? e.yt : []).filter((x: unknown) => typeof x === "string" && /^[A-Za-z0-9_-]{11}$/.test(x)) as string[];
  const { cover, gallery } = splitImages(e.cover, Array.isArray(e.gallery) ? e.gallery : []);
  const price = Math.max(0, num(e.price_usd ?? e.price));
  return {
    source: "clearlydev",
    resource_id: 0,
    title: String(e.title ?? "").trim(),
    summary: "",
    url: String(e.url ?? ""),
    bbb_category: null,
    tags: String(e.tags ?? ""),
    currency: String(e.currency || "USD"),
    list_price: price,
    final_price: price,
    robux_price: robuxFor(price),
    cover,
    gallery,
    youtube: yt,
    video: yt.length ? `https://www.youtube.com/embed/${yt[0]}` : null,
    version: null,
    purchases: null,
    description_text: text.slice(0, 12000),
    bullets_draft: bullets(text),
    has_description: !!text,
    has_category: true,
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

type Img = { bytes: Uint8Array; kind: { ext: string; mime: string }; base: string };
// Downloads are spaced per host (BuiltByBit's own image host gets 1s between requests);
// the CDN uploads that follow run alongside the next download.
const NEXT_IMAGE_SLOT: Record<string, number> = {};
async function downloadImage(url: string, host: string): Promise<Img> {
  const tries = host === "builtbybit" && fullSize(url) !== url ? [fullSize(url), url] : [url];
  let lastErr: Error = new Error("image failed");
  for (const u of tries) {
    const wait = (NEXT_IMAGE_SLOT[host] ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    NEXT_IMAGE_SLOT[host] = Date.now() + (IMAGE_GAP[host] ?? 500);
    try {
      const res = await fetch(u, { headers: { Accept: "image/*" }, signal: AbortSignal.timeout(25000) });
      if (!res.ok) { await res.body?.cancel(); throw new Error(`image returned ${res.status}`); }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image is over 25 MB");
      const kind = sniff(bytes);
      if (!kind) throw new Error("not a jpg/png/gif/webp/avif image");
      // Attachment links end in a slash: /attachments/image_2026-11-02_155721703-png.1609463/
      const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "image").replace(/\.[a-z0-9]+$/i, "");
      const base = slugify(last).replace(/-(png|jpe?g|gif|webp|avif)$/, "").slice(0, 60) || "image";
      return { bytes, kind, base };
    } catch (e) { lastErr = e as Error; }
  }
  throw lastErr;
}

// deno-lint-ignore no-explicit-any
async function uploadImage(admin: any, img: Img, slug: string, sub: "thumbnails" | "gallery", uploadedBy: string | null): Promise<string> {
  const cdnPath = `media/${slug}/${sub}/${crypto.randomUUID().slice(0, 8)}-${img.base}.${img.kind.ext}`;
  const publicUrl = cdnPublicUrl(cdnPath);
  // Ledger first, same as admin-get-upload-url, so the file is on record even if the save fails.
  const { error: ledgerErr } = await admin.from("storage_uploads").upsert({
    stored_path: publicUrl, kind: sub === "thumbnails" ? "thumbnail" : "gallery", product_slug: slug,
    original_name: `${img.base}.${img.kind.ext}`, uploaded_by: uploadedBy,
  }, { onConflict: "stored_path" });
  if (ledgerErr) console.error("[admin-bbb-import] could not record upload:", ledgerErr.message);
  const fd = new FormData();
  fd.append("file", new Blob([img.bytes as unknown as BlobPart], { type: img.kind.mime }), `${img.base}.${img.kind.ext}`);
  const up = await fetch(await cdnSignedUrl("upload", cdnPath, { maxBytes: 100 * 1024 * 1024 }), {
    method: "POST", body: fd, signal: AbortSignal.timeout(60000),
  });
  const d = await up.json().catch(() => ({}));
  if (!up.ok || d?.ok === false) throw new Error(String(d?.error || `CDN returned ${up.status}`));
  return publicUrl;
}

// deno-lint-ignore no-explicit-any
async function uniqueSlug(admin: any, base: string) {
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
    // deno-lint-ignore no-explicit-any
    const admin: any = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
          ...(body.raw === true ? { raw: { bbcode: String(r.Description?.bbcode ?? ""), html: String(r.Description?.html ?? ""), carousel: r.carousel_image_urls ?? null, keys: Object.keys(r) } } : {}),
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
      const isCd = (it: Obj) => it.source === "clearlydev";
      const bad = items.find((it) => !CATEGORIES[String(it.cat ?? "")] || (isCd(it) ? !(it.external?.url && it.external?.title) : !(num(it.resource_id) > 0)));
      if (bad) return json({ ok: false, error: `Bad item (resource_id or external, cat): ${JSON.stringify(bad).slice(0, 200)}` }, 400);
      const useCdn = cdnEnabled();
      const bbbIds = items.filter((it) => !isCd(it)).map((it) => Math.trunc(num(it.resource_id)));
      const found = bbbIds.length ? await fetchListings(token, bbbIds) : new Map<number, Obj>();
      const legalCache = new Map<string, Obj | null>();
      const getLegal = async (slug: string): Promise<Obj | null> => {
        if (legalCache.has(slug)) return legalCache.get(slug)!;
        let row: Obj | null = null;
        const { data: p } = await admin.from("products").select("id").eq("slug", slug).maybeSingle();
        if (p) {
          const { data: l } = await admin.from("product_legal").select("*").eq("product_id", p.id).maybeSingle();
          if (l) {
            const copy: Obj = { ...l };
            delete copy.product_id;
            delete copy.updated_at;
            row = copy;
          }
        }
        legalCache.set(slug, row);
        return row;
      };
      const results: Obj[] = [];

      for (const it of items) {
        const cd = isCd(it);
        const rid = cd ? 0 : Math.trunc(num(it.resource_id));
        const ref = cd ? String(it.external.url) : String(rid);
        const fail = (status: string, reason: string, extra: Obj = {}) => results.push({ ref, ok: false, status, reason, ...extra });
        if (overBudget(25000)) { fail("not_started", "Out of time, send it again."); continue; }
        if (!cd && imported.has(rid)) { fail("skipped", "Already imported", { slug: slugById.get(imported.get(rid)!) ?? null }); continue; }
        let l: ReturnType<typeof listing>;
        if (cd) l = fromClearly({ ...it.external, price_usd: it.external.price_usd ?? it.external.price });
        else {
          const r = found.get(rid);
          if (!r) { fail("not_found", "Not returned by /v2/resources/creator/resources (not ours, or removed)"); continue; }
          l = listing(r);
        }
        const title = String(it.title || l.title).trim().slice(0, 200);
        const same = byTitle.get(norm(title));
        if (same && it.force !== true) { fail("skipped", "A product with this title already exists", { slug: same.slug }); continue; }

        const slug = await uniqueSlug(admin, slugify(title));
        const host = cd ? "clearlydev" : "builtbybit";
        const warnings: string[] = [];
        if (!useCdn) warnings.push("CDN is not configured, images left on the marketplace CDN");

        // Images: downloads run one after another (spaced), uploads overlap with the next download.
        const jobs: Array<{ sub: "thumbnails" | "gallery"; url: string }> = [];
        if (l.cover) jobs.push({ sub: "thumbnails", url: l.cover });
        for (const g of l.gallery.slice(0, MAX_GALLERY)) jobs.push({ sub: "gallery", url: g });
        if (l.gallery.length > MAX_GALLERY) warnings.push(`Only the first ${MAX_GALLERY} of ${l.gallery.length} gallery images were copied`);
        const pending: Array<Promise<{ sub: string; url?: string }>> = [];
        for (const j of jobs) {
          if (!useCdn) { pending.push(Promise.resolve({ sub: j.sub, url: j.url })); continue; }
          if (overBudget(15000)) { warnings.push("Ran short on time, some images were not copied"); break; }
          try {
            const img = await downloadImage(j.url, host);
            pending.push(uploadImage(admin, img, slug, j.sub, userId).then((u) => ({ sub: j.sub, url: u }), (e) => { warnings.push(`${j.sub === "thumbnails" ? "Cover" : "Gallery image"} did not upload: ${(e as Error).message}`); return { sub: j.sub }; }));
          } catch (e) { warnings.push(`${j.sub === "thumbnails" ? "Cover" : "Gallery image"} did not download: ${(e as Error).message}`); }
        }
        const done = await Promise.all(pending);
        let image: string | null = done.find((d) => d.sub === "thumbnails" && d.url)?.url ?? null;
        const gallery = done.filter((d) => d.sub === "gallery" && d.url).map((d) => d.url as string);
        if (!image && gallery.length) { image = gallery.shift()!; warnings.push("No cover, used the first gallery image"); }

        const price = it.price_usd != null ? Math.max(0, num(it.price_usd)) : l.list_price;
        const subcat = String(it.subcat || "").trim() || guessSubcat(String(it.cat), `${title} ${l.tags} ${l.summary}`);
        const row = {
          slug, title,
          price_usd: price,
          robux_price: robuxFor(price),
          resell_available: false,
          image,
          gallery,
          video: l.video ?? "",
          description: String(it.description || shortDesc(l.summary, l.bullets_draft, title)).trim().slice(0, 300),
          long_description: String(it.long_description || l.bullets_draft || "").trim().slice(0, 8000),
          cat: String(it.cat),
          subcat,
          platform: "Roblox",
          page: CATEGORIES[String(it.cat)],
          storage_path: PLACEHOLDER,
          is_active: false,
        };
        const { data: created, error: insErr } = await admin.from("products").insert(row).select("id").single();
        if (insErr || !created) { fail("error", "Could not create product: " + (insErr?.message ?? "unknown"), { warnings }); continue; }
        if (!cd) {
          const { error: linkErr } = await admin.from("bbb_imports").insert({ resource_id: rid, product_id: created.id, bbb_url: l.url, bbb_title: l.title, imported_by: userId });
          if (linkErr) {
            await admin.from("products").delete().eq("id", created.id);
            fail("error", "Could not save the import link: " + linkErr.message);
            continue;
          }
          imported.set(rid, created.id);
        }
        byTitle.set(norm(title), { id: created.id, slug, title, is_active: false });

        // "Uploaded on": a BuiltByBit link marks BuiltByBit; a ClearlyDev-only link marks both.
        const now = new Date().toISOString();
        const markets = cd ? ["builtbybit", "clearlydev"] : ["builtbybit"];
        const { error: mpErr } = await admin.from("marketplace_listings").upsert(
          markets.map((m) => ({ product_id: created.id, marketplace: m, status: "live", synced_at: now, updated_at: now })),
          { onConflict: "product_id,marketplace" },
        );
        if (mpErr) warnings.push("Uploaded-on ticks did not save: " + mpErr.message);

        // Legal data copied from another product (same proof file paths: the delete-product
        // check keeps a file while any other product still points at it).
        let legal = false;
        if (it.legal_from) {
          const src = await getLegal(String(it.legal_from));
          if (!src) warnings.push(`Legal source "${it.legal_from}" not found`);
          else {
            const lrow: Obj = { ...src, product_id: created.id, updated_at: now };
            if (Array.isArray(it.legal_license_types)) lrow.license_types = it.legal_license_types;
            const { error: lErr } = await admin.from("product_legal").upsert(lrow);
            if (lErr) warnings.push("Legal copy failed: " + lErr.message);
            else {
              legal = true;
              if (price <= 0 && !lrow.can_be_free) warnings.push("Free, but the copied legal has can_be_free off");
              if (price > 0 && num(lrow.min_regular_usd) > price) warnings.push("Price is under the copied minimum regular price");
            }
          }
        }

        const taskRows = (Array.isArray(it.tasks) ? it.tasks : [])
          .filter((t: Obj) => t && TASK_MARKETS.includes(String(t.marketplace)) && String(t.title || "").trim())
          .map((t: Obj) => ({ product_id: created.id, marketplace: String(t.marketplace), title: String(t.title).trim().slice(0, 200), created_by: userId }));
        if (taskRows.length) {
          const { error: tErr } = await admin.from("marketplace_tasks").insert(taskRows);
          if (tErr) warnings.push("Tasks did not save: " + tErr.message);
        }
        if (l.youtube.length > 1) warnings.push(`${l.youtube.length} YouTube videos found, used the first`);
        if (l.currency && l.currency !== "USD") warnings.push(`Price is in ${l.currency}, not USD`);
        results.push({
          ref, ok: true, status: "created", slug, price_usd: price, robux_price: row.robux_price, subcat,
          gallery_count: gallery.length, cover: !!image, video: !!row.video, legal, tasks: taskRows.length, warnings,
        });
      }
      return json({ ok: true, results });
    }

    // check_stored: re-checks every product file, add-on file and legal proof file, gently (4 at a time,
    // unknown answers retried). Same checks as the daily file audit, nothing is notified or changed.
    if (action === "check_stored") {
      const [{ data: prods }, { data: legal }, { data: addons }] = await Promise.all([
        admin.from("products").select("id, slug, storage_path").limit(5000),
        admin.from("product_legal").select("product_id, proof_files, dev_proof_files").limit(5000),
        admin.from("product_addons").select("product_id, title, storage_path").limit(5000),
      ]);
      const slugOf = new Map<string, string>(((prods ?? []) as Obj[]).map((p) => [p.id, p.slug]));
      const jobs: Array<{ slug: string; kind: string; name: string; path: string }> = [];
      for (const p of (prods ?? []) as Obj[]) if (p.storage_path && p.storage_path !== PLACEHOLDER) jobs.push({ slug: p.slug, kind: "product file", name: p.slug, path: p.storage_path });
      for (const a of (addons ?? []) as Obj[]) if (a.storage_path) jobs.push({ slug: slugOf.get(a.product_id) ?? a.product_id, kind: "add-on", name: a.title, path: a.storage_path });
      for (const l of (legal ?? []) as Obj[]) {
        for (const [kind, list] of [["proof of license", l.proof_files], ["proof of development", l.dev_proof_files]] as const) {
          for (const f of Array.isArray(list) ? list : []) {
            const path = f && typeof f === "object" ? f.path : null;
            jobs.push({ slug: slugOf.get(l.product_id) ?? l.product_id, kind, name: typeof f === "string" ? f : String(f?.name ?? ""), path: path ? String(path) : "" });
          }
        }
      }
      const answers = new Map<string, boolean | null>();
      const allPaths = [...new Set(jobs.map((j) => j.path).filter(Boolean))];
      const from = Math.max(0, Math.trunc(num(body.from, 0)));
      const uniquePaths = allPaths.slice(from, from + Math.max(1, Math.trunc(num(body.count, allPaths.length))));
      const inSlice = new Set(uniquePaths);
      let idx = 0, timedOut = false;
      const worker = async () => {
        while (idx < uniquePaths.length) {
          if (overBudget(8000)) { timedOut = true; return; }
          const p = uniquePaths[idx++];
          let r = await storedFileExists(admin, p);
          for (let t = 0; r === null && t < 2; t++) { await sleep(1000); r = await storedFileExists(admin, p); }
          answers.set(p, r);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      const missing = jobs.filter((j) => (!j.path && from === 0) || (j.path && answers.get(j.path) === false));
      const unknown = jobs.filter((j) => j.path && answers.has(j.path) && answers.get(j.path) === null);
      const unchecked = jobs.filter((j) => j.path && inSlice.has(j.path) && !answers.has(j.path));
      const brief = (j: { slug: string; kind: string; name: string; path: string }) => `${j.slug} | ${j.kind} | ${j.name} | ${j.path || "(no path)"}`;
      return json({
        ok: true, entries: jobs.length, totalUniquePaths: allPaths.length, sliceFrom: from, sliceSize: uniquePaths.length,
        present: [...answers.values()].filter((v) => v === true).length,
        missing: missing.map(brief), unknown: unknown.map(brief), unchecked: unchecked.length, timedOut,
      });
    }

    // verify_files: items = [{ slug, size }]. Asks the CDN for the size of each product's stored file.
    if (action === "verify_files") {
      const items: Obj[] = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ ok: false, error: "Send items." }, 400);
      if (items.length > 200) return json({ ok: false, error: "At most 200 items per call." }, 400);
      const { data: rows } = await admin.from("products").select("slug, storage_path, tech").in("slug", items.map((i) => String(i.slug)));
      const bySlug = new Map<string, Obj>(((rows ?? []) as Obj[]).map((r) => [r.slug, r]));
      const bad: string[] = [];
      let okCount = 0;
      for (const it of items) {
        const slug = String(it.slug);
        const p = bySlug.get(slug);
        const sp = String(p?.storage_path ?? "");
        if (!p || !sp.startsWith("cdn:")) { bad.push(`${slug}: not attached`); continue; }
        let stored = -1;
        try {
          const res = await fetch(await cdnDownloadUrl(sp, String(p.tech?.fileName ?? "file"), 120), { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(20000) });
          const range = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
          stored = range ? Number(range[1]) : -1;
          await res.body?.cancel();
        } catch { /* stays -1 */ }
        if (stored === Math.trunc(num(it.size))) okCount++; else bad.push(`${slug}: CDN has ${stored}, expected ${it.size}`);
      }
      return json({ ok: true, checked: items.length, verified: okCount, bad });
    }

    // attach_files: items = [{ slug, path ("cdn:..." as returned by admin-get-upload-url), size, fileName }].
    // The stored file must exist on the CDN with exactly `size` bytes before it is attached.
    if (action === "attach_files") {
      const items: Obj[] = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return json({ ok: false, error: "Send items." }, 400);
      if (items.length > 40) return json({ ok: false, error: "At most 40 items per call." }, 400);
      const results: Obj[] = [];
      for (const it of items) {
        const slug = String(it.slug ?? "");
        const path = String(it.path ?? "");
        const fileName = String(it.fileName ?? "").slice(0, 200);
        const size = Math.trunc(num(it.size));
        if (!slug || !path.startsWith("cdn:") || size <= 0 || !fileName) { results.push({ slug, ok: false, error: "Bad item" }); continue; }
        let stored = -1;
        try {
          const res = await fetch(await cdnDownloadUrl(path, fileName, 120), { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(20000) });
          const range = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
          stored = range ? Number(range[1]) : res.ok ? num(res.headers.get("content-length"), -1) : -1;
          await res.body?.cancel();
        } catch { /* stays -1 */ }
        if (stored !== size) { results.push({ slug, ok: false, error: `Stored size ${stored} does not match ${size}` }); continue; }
        const { data: p } = await admin.from("products").select("id, tech").eq("slug", slug).maybeSingle();
        if (!p) { results.push({ slug, ok: false, error: "No product with this slug" }); continue; }
        const dot = fileName.lastIndexOf(".");
        const kb = size / 1024;
        const tech = { ...(p.tech ?? {}), format: dot >= 0 ? fileName.slice(dot).toLowerCase() : "", size: kb >= 1024 ? (kb / 1024).toFixed(1) + " MB" : kb >= 1 ? kb.toFixed(1) + " KB" : size + " B", fileName };
        const { error: upErr } = await admin.from("products").update({ storage_path: path, tech }).eq("id", p.id);
        results.push(upErr ? { slug, ok: false, error: "Could not save: " + upErr.message } : { slug, ok: true, size });
      }
      return json({ ok: true, results });
    }

    return json({ ok: false, error: "Unknown action." }, 400);
  } catch (err) {
    console.error("[admin-bbb-import] error:", err);
    return json({ ok: false, error: (err as Error).message || "Server error." }, 500);
  }
});
