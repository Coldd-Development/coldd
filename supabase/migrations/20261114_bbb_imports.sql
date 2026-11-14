-- BuiltByBit listing -> coldd product links, written by the admin-bbb-import edge function.
-- One row per imported listing, so the same listing is never imported twice and the
-- BuiltByBit stats can be matched to a product by id instead of by title.
-- Admin read only; the function writes with the service role.

create table if not exists public.bbb_imports (
  resource_id  bigint primary key,
  product_id   uuid not null references public.products(id) on delete cascade,
  bbb_url      text,
  bbb_title    text,
  imported_at  timestamptz not null default now(),
  imported_by  uuid references public.profiles(id) on delete set null
);
create unique index if not exists bbb_imports_product_idx on public.bbb_imports (product_id);

alter table public.bbb_imports enable row level security;
do $$ begin
  create policy "bbb_imports_admin_select" on public.bbb_imports for select using (public.is_admin());
exception when duplicate_object then null; end $$;

revoke all on public.bbb_imports from public, anon;
grant select on public.bbb_imports to authenticated;
