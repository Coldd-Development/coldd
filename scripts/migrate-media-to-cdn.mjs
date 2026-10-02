// scripts/migrate-media-to-cdn.mjs
//
// Moves EVERYTHING out of Supabase Storage onto the Ultimate Hosting storage:
//   public  bucket "product-media" -> cdn.coldd.dev/<path>      (thumbnails, gallery, avatars)
//   private bucket "product-files" -> private area, "cdn:" path  (paid downloads, staged files, legal docs)
//
// Every file is copied, then read back from the CDN and compared (sha256). Only
// when ALL copies verify does --apply rewrite the database references. It NEVER
// deletes from Supabase, and --apply first writes a rollback file with every old
// value. Safe to re-run: files are overwritten, DB rows already switched are skipped.
//
//   node scripts/migrate-media-to-cdn.mjs            # dry run: copy + verify only
//   node scripts/migrate-media-to-cdn.mjs --apply    # also switch DB references
//
// Env (see .env.example): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// CDN_UPLOAD_URL, CDN_UPLOAD_SECRET, CDN_PUBLIC_URL. Run on your own machine.

import { createHash, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(1); } return v; };
const SB = need("SUPABASE_URL").replace(/\/+$/, "");
const KEY = need("SUPABASE_SERVICE_ROLE_KEY");
const UP = need("CDN_UPLOAD_URL");
const SECRET = need("CDN_UPLOAD_SECRET");
const PUB = need("CDN_PUBLIC_URL").replace(/\/+$/, "");
const DL = process.env.CDN_DOWNLOAD_URL || `${PUB}/download.php`;
const APPLY = process.argv.includes("--apply");
const CHUNK = 4 * 1024 * 1024;
const OLD_PUBLIC = `${SB}/storage/v1/object/public/product-media/`;
const sb = { Authorization: `Bearer ${KEY}`, apikey: KEY };

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const hmac = (parts) => createHmac("sha256", SECRET).update(parts.join("|")).digest("hex");
const pubPath = (p) => (p.startsWith("avatars/") ? p : `media/${p}`);

function signedUpload(path, priv) {
  const exp = Math.floor(Date.now() / 1000) + (priv ? 3600 : 300);
  const max = 4 * 1024 * 1024 * 1024, ow = "1", vis = priv ? "priv" : "pub";
  const sig = hmac(["v2", "upload", path, exp, max, ow, vis]);
  return `${UP}?${new URLSearchParams({ action: "upload", path, exp, max, ow, vis, sig })}`;
}
function signedDownload(path, name) {
  const exp = Math.floor(Date.now() / 1000) + 600;
  return `${DL}?${new URLSearchParams({ path, name, exp, sig: hmac(["v2", "download", path, exp, name]) })}`;
}

async function putPrivate(path, buf) {
  const url = signedUpload(path, true);
  let offset = 0;
  do {
    const end = Math.min(offset + CHUNK, buf.length);
    const fd = new FormData();
    fd.append("file", new Blob([buf.subarray(offset, end)]), "chunk");
    const last = end >= buf.length ? 1 : 0;
    const r = await fetch(`${url}&offset=${offset}&last=${last}`, { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(`chunk @${offset}: ${j.error || r.status}`);
    offset = end;
  } while (offset < buf.length);
}
async function putPublic(path, buf, type) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type }), path.split("/").pop());
  const r = await fetch(signedUpload(path, false), { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`upload: ${j.error || r.status}`);
}

async function listAll(bucket, prefix = "") {
  const res = await fetch(`${SB}/storage/v1/object/list/${bucket}`, {
    method: "POST", headers: { ...sb, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0 }),
  });
  if (!res.ok) throw new Error(`list ${bucket} failed: ${res.status}`);
  const out = [];
  for (const it of await res.json()) {
    const p = prefix ? `${prefix}/${it.name}` : it.name;
    if (it.id === null) out.push(...(await listAll(bucket, p))); else out.push(p);
  }
  return out;
}
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

let failed = 0;
const pubFiles = await listAll("product-media");
const privFiles = await listAll("product-files");
console.log(`Found ${pubFiles.length} public + ${privFiles.length} private file(s)`);

for (const p of pubFiles) {
  try {
    const src = await fetch(OLD_PUBLIC + enc(p));
    if (!src.ok) throw new Error(`download ${src.status}`);
    const buf = Buffer.from(await src.arrayBuffer());
    const dst = pubPath(p);
    await putPublic(dst, buf, src.headers.get("content-type") || "application/octet-stream");
    const back = await fetch(`${PUB}/${dst}?verify=${Date.now()}`);
    if (!back.ok) throw new Error(`cdn fetch ${back.status}`);
    if (sha(Buffer.from(await back.arrayBuffer())) !== sha(buf)) throw new Error("checksum mismatch");
    console.log(`OK    public  ${p} -> ${dst}`);
  } catch (e) { failed++; console.error(`FAIL  public  ${p}: ${e.message}`); }
}

for (const p of privFiles) {
  try {
    if (p === "_shared/placeholder.zip") { console.log(`SKIP  private ${p} (placeholder default, stays on Supabase)`); continue; }
    const src = await fetch(`${SB}/storage/v1/object/${"product-files"}/${enc(p)}`, { headers: sb });
    if (!src.ok) throw new Error(`download ${src.status}`);
    const buf = Buffer.from(await src.arrayBuffer());
    await putPrivate(p, buf);
    const back = await fetch(signedDownload(p, p.split("/").pop()));
    if (!back.ok) throw new Error(`cdn read-back ${back.status}`);
    if (sha(Buffer.from(await back.arrayBuffer())) !== sha(buf)) throw new Error("checksum mismatch");
    console.log(`OK    private ${p} (${buf.length} bytes)`);
  } catch (e) { failed++; console.error(`FAIL  private ${p}: ${e.message}`); }
}

if (failed) { console.error(`\n${failed} file(s) failed. Not touching the database.`); process.exit(1); }
if (!APPLY) { console.log("\nAll copies verified. Re-run with --apply to switch the database references."); process.exit(0); }

// ---- DB rewrite (only reached when every file verified) ----
const rest = async (path, init = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init, headers: { ...sb, "Content-Type": "application/json", Prefer: "return=minimal", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return init.method === "PATCH" ? null : r.json();
};
const swapUrl = (u) => {
  if (typeof u !== "string" || !u.startsWith(OLD_PUBLIC)) return u;
  const [path, qs] = u.slice(OLD_PUBLIC.length).split("?"); // avatar urls carry ?t=
  return `${PUB}/${pubPath(decodeURIComponent(path))}${qs ? "?" + qs : ""}`;
};
const swapPriv = (p) => (typeof p === "string" && p && !p.startsWith("cdn:") && p !== "_shared/placeholder.zip" ? `cdn:${p}` : p);

const products = await rest("products?select=id,image,gallery,storage_path");
const profiles = await rest("profiles?select=id,avatar_url&avatar_url=not.is.null");
const unreleased = await rest("unreleased_files?select=id,storage_path");
const legal = await rest("product_legal?select=product_id,proof_files,dev_proof_files");
writeFileSync(`media-migration-rollback-${Date.now()}.json`, JSON.stringify({ products, profiles, unreleased, legal }, null, 2));
console.log("Rollback file written (old values).");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mapFiles = (arr) => (Array.isArray(arr) ? arr.map((f) => (f && f.path ? { ...f, path: swapPriv(f.path) } : f)) : arr);
let changed = 0;
const patch = async (table, filter, body) => { await rest(`${table}?${filter}`, { method: "PATCH", body: JSON.stringify(body) }); changed++; };

for (const r of products) {
  const next = { image: swapUrl(r.image), gallery: Array.isArray(r.gallery) ? r.gallery.map(swapUrl) : r.gallery, storage_path: swapPriv(r.storage_path) };
  if (!same(next, { image: r.image, gallery: r.gallery, storage_path: r.storage_path })) await patch("products", `id=eq.${r.id}`, next);
}
for (const r of profiles) { const a = swapUrl(r.avatar_url); if (a !== r.avatar_url) await patch("profiles", `id=eq.${r.id}`, { avatar_url: a }); }
for (const r of unreleased) { const s = swapPriv(r.storage_path); if (s !== r.storage_path) await patch("unreleased_files", `id=eq.${r.id}`, { storage_path: s }); }
for (const r of legal) {
  const next = { proof_files: mapFiles(r.proof_files), dev_proof_files: mapFiles(r.dev_proof_files) };
  if (!same(next, { proof_files: r.proof_files, dev_proof_files: r.dev_proof_files })) await patch("product_legal", `product_id=eq.${r.product_id}`, next);
}
console.log(`Updated ${changed} row(s). Supabase originals were left untouched.`);
