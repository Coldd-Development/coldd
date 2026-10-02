# cdn.coldd.dev: file storage on the Hetzner Storage Box

The Storage Box is the home of every file. Ultimate Hosting is only the middleman (it runs two small
PHP scripts); Supabase keeps the database and logins only.

```
browser --(HMAC-signed POST, chunked for big files)--> upload.php --SFTP--> Storage Box
buyer   --(signed GET, resumable)---------------------> download.php <-SFTP-- Storage Box
edge functions (Supabase) sign the tokens; the secret never reaches the browser
```

| What | Source of truth | Also on the hosting disk? |
|---|---|---|
| Thumbnails, gallery, avatars | Storage Box `coldd/public/...` | yes, a convenience copy in `public_html/` so nginx serves it fast |
| Paid product files, staged files, legal docs | Storage Box `coldd/private/...` | no (only a temp folder while a big upload is being assembled) |

Stored paths: images are `https://cdn.coldd.dev/media/...` or `/avatars/...`; private files are saved as
`cdn:<path>` in the database. (Never use a `products/` prefix: the `*.coldd.dev/product*` Worker route swallows it.)

If the Storage Box is unreachable, uploads/downloads return a friendly "storage temporarily unavailable, try
again" message and images already on the hosting disk / Cloudflare keep working.

## Files on the hosting account (Hestia File Manager, domain `coldd.dev`, alias `cdn.coldd.dev`)
PHP is only allowed to read `public_html`, `private` and `tmp` (open_basedir), so:

| File | Goes in |
|---|---|
| `upload.php`, `download.php` | `web/coldd.dev/public_html/` |
| `cdn-lib.php`, `cdn-config.php`, `storagebox_key`, `storagebox_key.pub` | `web/coldd.dev/private/` |

The Hestia File Manager does not overwrite: rename the old file first (e.g. `upload.php` -> `upload.v2.txt`), then upload.

## Connect the Storage Box
1. Hetzner Console -> Storage Box -> enable **SSH support**. Note the username (`uXXXXXX`) and host (`uXXXXXX.your-storagebox.de`).
2. `node scripts/make-box-config.mjs uXXXXXX uXXXXXX.your-storagebox.de` generates a fresh SSH key and a
   complete `cdn-config.php` (host key pinned) in `scratchpad/cdn-upload/`.
3. Add `scratchpad/cdn-upload/private/storagebox_key.pub` as an authorized key on the box (Hetzner Console -> Storage Box -> SSH keys).
4. Put the files from `scratchpad/cdn-upload/` on the server (table above).
5. Check: `https://cdn.coldd.dev/upload.php?action=ping` shows `"box":true,"sftp":true`. Then `node scripts/cdn-selftest.mjs`
   does a signed put/get/delete on the box and names the exact step that fails.
6. Migrate existing files onto the box: `node scripts/migrate-media-to-cdn.mjs` (re-copies from Supabase, verifies by reading back).

## DNS / certificates (already done)
- Cloudflare DNS: `cdn` A record -> hosting IP, proxied. SSL mode Full.
- Hestia: `cdn.coldd.dev` is an alias of `coldd.dev` (the account allows one web domain); a Cloudflare Origin
  Certificate (with Cloudflare's Origin CA root in the CA box) is installed on `coldd.dev`.

## Turn on / roll back (Supabase secrets)
`CDN_PUBLIC_URL`, `CDN_UPLOAD_URL`, `CDN_UPLOAD_SECRET` (same value as `secret` in `cdn-config.php`). Optional
`CDN_DOWNLOAD_URL`. `STORAGE_DRIVER=supabase` sends new uploads back to Supabase Storage instantly.

## Backups
The Storage Box is the primary, so back IT up:
1. Hetzner Console -> Storage Box -> **Snapshots**: enable an automatic snapshot plan (daily, keep 7-10). This protects against deletes and bad overwrites.
2. A second, independent copy elsewhere (a second Storage Box, or Backblaze B2 / Cloudflare R2 via `rclone`), run weekly. Snapshots on the same box do not protect against losing the box itself.
3. Supabase Storage still holds the original copies of everything migrated so far: keep them until the box backups are verified.
4. Test a restore once.

## Moving to another server later
Install `upload.php`, `download.php`, `cdn-lib.php`, `cdn-config.php` and the key on the new host, repoint the `cdn`
DNS record. The files stay on the Storage Box, so nothing is copied and no code or database changes.

## Notes and limits
- Images: JPG/PNG/WebP/GIF/AVIF, content checked from the bytes, 10 MB (5 MB avatars). Private files: any type, up to 4 GB, uploaded in 4 MB retried chunks; the hosting account needs temporary disk space for one file at a time while it is assembled.
- Upload links last 5 minutes (1 hour for private files); download links 2 minutes (legal-doc links 7 days).
- Needs PHP's curl built with SFTP (the `ping` response shows `"sftp":true`).
- Not done: automatic WebP/AVIF re-encoding on upload.
