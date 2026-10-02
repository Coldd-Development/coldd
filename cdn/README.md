# cdn.coldd.dev: all file storage on Ultimate Hosting (+ Storage Box)

Everything file-shaped lives on your own storage, not Supabase. Supabase keeps only the database and auth.

| What | Where it lives | How it is served |
|---|---|---|
| Thumbnails, gallery, avatars | `public_html/` of `cdn.coldd.dev` | nginx, public, long browser cache |
| Paid product files, staged files, legal docs | `private/files/` (Hestia's `private` folder, OUTSIDE the web root) | only via `download.php` with a signed link that expires in minutes, minted after the purchase check |

```
browser --(HMAC-signed POST, chunked for big files)--> upload.php --> disk
buyer   --(signed GET, resumable)---------------------> download.php --> private-files/
edge fns (Supabase) sign the tokens; the secret never reaches the browser
nightly: disk --rsync--> Hetzner Storage Box (30 days of history)
```

Until the CDN secrets are set, everything keeps using Supabase Storage, so nothing breaks while you set this up. Files migrated later keep working: paths starting with `cdn:` are on the hosting account, everything else is a legacy Supabase object.

## Where does the data physically sit? (pick one)
- **A. On the hosting account's disk (default, no root needed).** `private_root` and `root` default to folders in your Hestia home. Disk shows "unlimited" in your panel. Backups go to the Storage Box (step 5).
- **B. Directly on the Storage Box (needs root on the server).** If 91.98.39.105 is a VPS where you have root, mount the box (`sshfs` or `rclone mount`, or Hetzner's CIFS) at e.g. `/mnt/storagebox`, then set `'private_root' => '/mnt/storagebox/private-files'` and `'root' => '/mnt/storagebox/public'` in `cdn-config.php` and point the web domain's `public_html` at it. Then use the box's own snapshots as backups. Nothing else changes.

## 1. Create the site (Hestia panel, `webpanel.ultimatehosting.com.uy:8083`)
1. WEB -> Add Web Domain -> `cdn.coldd.dev`; enable Let's Encrypt SSL (after DNS in step 2). Use a PHP 8.1+ template.
2. Upload `cdn/upload.php` and `cdn/download.php` into `/home/<hestia-user>/web/cdn.coldd.dev/public_html/`.
3. Create `/home/<hestia-user>/web/<domain>/private/cdn-config.php` (Hestia's `private` folder: PHP is allowed to read it, nginx never serves it; one level above `public_html` is NOT readable because of open_basedir):
   ```php
   <?php return ['secret' => 'PASTE_64_HEX_SECRET', 'allowed_origins' => ['https://coldd.dev']];
   ```
   Generate the secret with `openssl rand -hex 32` (or any 40+ random characters).
4. Make sure `/home/<hestia-user>/web/<domain>/private/files/` is not under `public_html` (it is created automatically on first upload).

## 2. DNS (Cloudflare)
| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `cdn` | `91.98.39.105` | DNS only until SSL works, then Proxied is fine for public images |

If proxied: SSL mode Full (strict), and add a Cache Rule so `cdn.coldd.dev/media/*` and `/avatars/*` cache for a month. **Do not cache `/download.php`** (Cloudflare skips caching it by default; keep it that way). Cloudflare's 100 MB proxied upload limit applies to proxied hosts, so for large product uploads keep `cdn` DNS-only (grey cloud), or give uploads their own unproxied name via `CDN_UPLOAD_URL`.

## 3. Turn it on (Supabase secrets)
```bash
supabase secrets set CDN_PUBLIC_URL=https://cdn.coldd.dev \
  CDN_UPLOAD_URL=https://cdn.coldd.dev/upload.php \
  CDN_UPLOAD_SECRET=<same secret>
supabase functions deploy admin-get-upload-url get-avatar-upload-url get-download-url admin-get-download-url admin-unreleased-files admin-generate-legal-docx
```
Health check: `https://cdn.coldd.dev/upload.php?action=ping` returns `{"ok":true}`.
Instant rollback for NEW uploads: `supabase secrets set STORAGE_DRIVER=supabase`.

## 4. Migrate existing files (nothing is deleted)
```bash
cp .env.example .env     # fill SUPABASE_SERVICE_ROLE_KEY + CDN_UPLOAD_SECRET, then load it into your shell
node scripts/migrate-media-to-cdn.mjs            # copies + sha256-verifies every file; DB untouched
node scripts/migrate-media-to-cdn.mjs --apply    # then switches the DB references (writes a rollback JSON first)
```
Covers `product-media` and `product-files`, and rewrites `products.image/gallery/storage_path`, `profiles.avatar_url`, `unreleased_files.storage_path`, `product_legal.proof_files/dev_proof_files`. Supabase copies stay as an extra backup; delete them only after you have run on the new storage for a while.

## 5. Backups (Storage Box)
1. Hetzner Console -> Storage Box -> enable SSH support; install the hosting account's SSH public key on the box.
2. Copy `cdn/backup.sh` to the account, create `~/.cdn-backup.env` from the "Backup" block in `.env.example`, `chmod +x`. It backs up BOTH `public_html` and `private-files` (set `SRC_PUBLIC` and `SRC_PRIVATE`).
3. Hestia -> CRON -> `30 3 * * *  /home/<hestia-user>/backup.sh`.
4. Also enable Hestia's own BACKUP for the account.
5. Test a restore once: `rsync -a -e "ssh -p 23" uXXXX@uXXXX.your-storagebox.de:coldd-cdn/current/ /tmp/restore-test/`.

If the hosting account has no rsync/SSH, tell me and I will switch the script to SFTP/rclone.

## Moving to another server later
Deploy `upload.php`, `download.php` and `cdn-config.php` on the new host, restore files from the Storage Box (command above), repoint the `cdn` A record. No code or database changes.

## Notes and limits
- Images: JPG/PNG/WebP/GIF/AVIF, content checked from the bytes, 10 MB (5 MB avatars). Private files: any type, up to 4 GB, uploaded in 4 MB retried chunks.
- Upload links last 5 minutes (1 hour for private files); download links 2 minutes (legal-doc links 7 days).
- If the host is down, uploads show "storage is temporarily unavailable"; images already cached by Cloudflare/browsers keep showing; downloads fail with a retry message.
- Not done: automatic WebP/AVIF re-encoding on upload (images are served as uploaded with far-future cache headers).
