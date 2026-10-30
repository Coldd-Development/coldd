-- storage_uploads: a ledger of every upload the admin panel starts.
--
-- admin-get-upload-url writes one row per signed upload link, BEFORE the browser sends the
-- file, so the real storage path of every file is on record even if the product that was
-- meant to point at it is never saved (closed tab, saved mid-upload, failed save). The
-- daily file check (cron-file-audit) uses it to find and re-link files a product lost.
-- Service role only: no policies, so the public API can't read or write it.

create table if not exists public.storage_uploads (
  id bigint generated always as identity primary key,
  stored_path text not null unique,         -- exactly as saved on a product: 'cdn:<path>' or a bucket path
  kind text not null,                       -- thumbnail | gallery | productFile | unreleasedFile | legalDoc | addonFile
  product_slug text,                        -- the slug (or draft-... id) the upload was made under
  original_name text not null,              -- the file name as picked on the admin's computer
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists storage_uploads_original_name_idx on public.storage_uploads (original_name);
alter table public.storage_uploads enable row level security;
revoke all on public.storage_uploads from anon, authenticated;
