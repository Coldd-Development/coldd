// supabase/functions/_shared/cdn.ts
//
// Talks to cdn/upload.php + cdn/download.php on the Ultimate Hosting account.
// Inert until CDN_UPLOAD_URL, CDN_DOWNLOAD_URL (optional), CDN_UPLOAD_SECRET
// and CDN_PUBLIC_URL are set as Supabase secrets - callers fall back to
// Supabase Storage when cdnEnabled() is false, so nothing breaks before setup.
//
//   supabase secrets set CDN_UPLOAD_URL=https://cdn.coldd.dev/upload.php \
//     CDN_UPLOAD_SECRET=<same value as cdn-config.php> CDN_PUBLIC_URL=https://cdn.coldd.dev
//   (CDN_DOWNLOAD_URL defaults to <CDN_PUBLIC_URL>/download.php)
//
// Private files (paid downloads, legal docs) are stored in products.storage_path
// etc. with a "cdn:" prefix, e.g. "cdn:my-pack/files/3f9a1c02-my-pack.zip".
// Anything without the prefix is a legacy Supabase Storage object and keeps
// working through the old code path.

const PRIVATE_PREFIX = "cdn:";
const UPLOAD_TTL = 300;
const PRIVATE_UPLOAD_TTL = 3600; // big files upload in many chunks
const DOWNLOAD_TTL = 600;

export function cdnEnabled(): boolean {
  return Deno.env.get("STORAGE_DRIVER") !== "supabase" &&
    !!(Deno.env.get("CDN_UPLOAD_URL") && Deno.env.get("CDN_UPLOAD_SECRET") && Deno.env.get("CDN_PUBLIC_URL"));
}

export function isCdnPath(p: string | null | undefined): boolean {
  return !!p && p.startsWith(PRIVATE_PREFIX);
}
export function stripCdnPrefix(p: string): string {
  return isCdnPath(p) ? p.slice(PRIVATE_PREFIX.length) : p;
}
export function withCdnPrefix(p: string): string {
  return PRIVATE_PREFIX + p;
}

export function cdnPublicUrl(path: string): string {
  return `${Deno.env.get("CDN_PUBLIC_URL")!.replace(/\/+$/, "")}/${path}`;
}

async function hmacHex(msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(Deno.env.get("CDN_UPLOAD_SECRET")!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Signed upload/delete URL. `path` has NO "cdn:" prefix. vis "priv" = not web-reachable. */
export async function cdnSignedUrl(
  action: "upload" | "delete",
  path: string,
  opts: { maxBytes?: number; overwrite?: boolean; priv?: boolean } = {},
): Promise<string> {
  const priv = !!opts.priv;
  const exp = Math.floor(Date.now() / 1000) + (priv ? PRIVATE_UPLOAD_TTL : UPLOAD_TTL);
  const max = opts.maxBytes ?? 0;
  const ow = opts.overwrite ? "1" : "0";
  const vis = priv ? "priv" : "pub";
  const sig = await hmacHex(["v2", action, path, exp, max, ow, vis].join("|"));
  const q = new URLSearchParams({ action, path, exp: String(exp), max: String(max), ow, vis, sig });
  return `${Deno.env.get("CDN_UPLOAD_URL")}?${q}`;
}

/** Short-lived download link for a private "cdn:" path. Caller must have verified access. */
export async function cdnDownloadUrl(storagePath: string, filename: string, ttlSeconds = DOWNLOAD_TTL): Promise<string> {
  const path = stripCdnPrefix(storagePath);
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacHex(["v2", "download", path, exp, filename].join("|"));
  const base = Deno.env.get("CDN_DOWNLOAD_URL") || `${Deno.env.get("CDN_PUBLIC_URL")!.replace(/\/+$/, "")}/download.php`;
  return `${base}?${new URLSearchParams({ path, name: filename, exp: String(exp), sig })}`;
}

/** Deletes a private file on the CDN host. Best effort: returns false instead of throwing. */
export async function cdnDeletePrivate(storagePath: string): Promise<boolean> {
  try {
    const res = await fetch(await cdnSignedUrl("delete", stripCdnPrefix(storagePath), { priv: true }), { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}
