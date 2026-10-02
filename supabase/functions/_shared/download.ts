// supabase/functions/_shared/download.ts
//
// Shared by get-download-url and admin-get-download-url.
//
// Two things the raw createSignedUrl() result gets wrong for a buyer:
//
//  1. The filename. Stored objects are named
//     "<slug>/files/<8-hex>-<original>.zip", so the browser saves the uuid
//     prefix as part of the name. `download` sets Content-Disposition on the
//     response, which is what the Save dialog actually reads.
//
//  2. The host. Signed URLs are built from the SUPABASE_URL that Supabase
//     injects into every function, which is always the project-ref origin
//     (<ref>.supabase.co) even when a custom domain is configured - so the
//     download prompt says "ekinmytmudjwfaqaqswp.supabase.co", which reads
//     as a phishing link to anyone who just paid us. Setting
//     PUBLIC_SUPABASE_URL re-hosts the signed URL onto that origin. The
//     signature covers the path and query, not the host, so swapping the
//     origin does not invalidate it.
//
//     This is only half the fix: PUBLIC_SUPABASE_URL must point at a domain
//     that actually terminates to this Supabase project (the Custom Domains
//     add-on, or a reverse proxy). Until one exists, leave it unset and the
//     URL is returned untouched rather than pointed at a host that 404s.

import { cdnDownloadUrl, isCdnPath } from "./cdn.ts";

export function publicSignedUrl(signedUrl: string): string {
  const publicBase = Deno.env.get("PUBLIC_SUPABASE_URL");
  if (!publicBase) return signedUrl;
  try {
    const target = new URL(publicBase);
    const url = new URL(signedUrl);
    url.protocol = target.protocol;
    url.host = target.host;
    return url.toString();
  } catch {
    // A malformed PUBLIC_SUPABASE_URL must not break paid downloads.
    return signedUrl;
  }
}

/** The name the buyer should see, with the storage uuid prefix stripped. */
export function downloadName(storagePath: string, title?: string): string {
  const base = String(storagePath || "").split("/").pop() || "download";
  const stripped = base.replace(/^[0-9a-f]{8}-/i, "");
  if (stripped) return stripped;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  return (title || "download").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ext;
}

/**
 * One entry point for "give this caller a link to a private file".
 * "cdn:" paths come from the Ultimate Hosting storage (signed download.php link);
 * anything else is a legacy Supabase Storage object. Caller has already
 * verified the user may have the file. Returns null if no link could be made.
 */
export async function signPrivateDownload(
  // deno-lint-ignore no-explicit-any
  admin: any,
  storagePath: string,
  filename?: string,
  ttlSeconds = 600,
): Promise<string | null> {
  if (isCdnPath(storagePath)) {
    return await cdnDownloadUrl(storagePath, filename || downloadName(storagePath), ttlSeconds);
  }
  const { data, error } = await admin.storage
    .from("product-files")
    .createSignedUrl(storagePath, ttlSeconds, filename ? { download: filename } : undefined);
  if (error || !data) return null;
  return publicSignedUrl(data.signedUrl);
}
