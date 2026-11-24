-- Finances (2026-11-25): each expense can record how it was paid and keep receipt
-- images. Receipts live in the private "finance-receipts" bucket, readable and
-- writable only when finance_allowed() is true (same lock as the finance tables);
-- the page shows them through short-lived signed links.
alter table public.finance_expenses add column if not exists payment_method text check (payment_method is null or char_length(payment_method) <= 40);
-- [{ path, name, type, size }] in the finance-receipts bucket
alter table public.finance_expenses add column if not exists receipts jsonb not null default '[]'::jsonb check (jsonb_typeof(receipts) = 'array');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('finance-receipts', 'finance-receipts', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists finance_receipts_select on storage.objects;
drop policy if exists finance_receipts_insert on storage.objects;
drop policy if exists finance_receipts_update on storage.objects;
drop policy if exists finance_receipts_delete on storage.objects;
create policy finance_receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'finance-receipts' and (select public.finance_allowed()));
create policy finance_receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'finance-receipts' and (select public.finance_allowed()));
create policy finance_receipts_update on storage.objects for update to authenticated
  using (bucket_id = 'finance-receipts' and (select public.finance_allowed()))
  with check (bucket_id = 'finance-receipts' and (select public.finance_allowed()));
create policy finance_receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'finance-receipts' and (select public.finance_allowed()));
