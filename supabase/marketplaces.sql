-- supabase/marketplaces.sql
--
-- Third-party marketplace tracking for the admin "Marketplaces" page.
-- Run once (idempotent): supabase db query --linked --file supabase/marketplaces.sql
--
-- marketplace_listings: one row per (product, marketplace). A MISSING row means
--   "not uploaded yet", so existing products need no backfill.
--     status 'live'         uploaded and up to date
--     status 'needs_update' uploaded, but the product changed since
--     status 'pending'      explicitly not uploaded yet
-- marketplace_tasks: free-form per-product to-dos ("Update price", ...).
--
-- Admin-only. The admin panel reads and writes these directly, same pattern as
-- admin_audit_log (RLS gated on public.is_admin()).

create table if not exists public.marketplace_listings (
  product_id uuid not null references public.products(id) on delete cascade,
  marketplace text not null check (marketplace in ('builtbybit', 'clearlydev', 'parcel', 'creatorstore')),
  status text not null default 'pending' check (status in ('pending', 'live', 'needs_update')),
  synced_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (product_id, marketplace)
);

create table if not exists public.marketplace_tasks (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  marketplace text not null check (marketplace in ('builtbybit', 'clearlydev', 'parcel', 'creatorstore')),
  title text not null check (char_length(title) between 1 and 200),
  done boolean not null default false,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null
);

create index if not exists marketplace_tasks_open_idx on public.marketplace_tasks (done, created_at);

alter table public.marketplace_listings enable row level security;
alter table public.marketplace_tasks enable row level security;

do $$ begin
  create policy "marketplace_listings_admin_all" on public.marketplace_listings
    for all using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "marketplace_tasks_admin_all" on public.marketplace_tasks
    for all using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null;
end $$;

-- Never readable or writable by the public / signed-in customers.
revoke all on public.marketplace_listings from anon, authenticated;
revoke all on public.marketplace_tasks from anon, authenticated;
grant select, insert, update, delete on public.marketplace_listings to authenticated;
grant select, insert, update, delete on public.marketplace_tasks to authenticated;
