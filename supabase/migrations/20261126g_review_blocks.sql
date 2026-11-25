-- Imported reviews an admin deleted for good (admin Reviews > Delete): the BuiltByBit, Creator
-- Store and Parcel imports skip these external_ids so a deleted review never comes back.
create table if not exists public.review_blocks (
  external_id text primary key,
  source text,
  listing_name text,
  user_name text,
  deleted_at timestamptz not null default now(),
  deleted_by uuid
);
alter table public.review_blocks enable row level security;
revoke all on public.review_blocks from anon, authenticated;
