-- Run this once in Supabase Dashboard -> SQL Editor. Safe to re-run
-- (idempotent). Run it BEFORE deploying the functions that read these tables.
--
-- PRODUCT ADD-ONS + BUNDLE DETAILS
--
-- 1. product_addons   - optional extras sold per product (Setup Service,
--                       Thumbnail Access, ...). Each has its own USD price, an
--                       optional Robux price and an optional deliverable file.
-- 2. order_addons     - what a buyer actually bought. A separate table from
--                       order_items on purpose: every reader of order_items
--                       (downloads, licences, reviews, referrals, analytics,
--                       reseller tracking) assumes one row = one product, and
--                       an add-on is not a product. Prices, title and file are
--                       snapshotted so editing or deleting an add-on later
--                       never changes or removes something already bought.
-- 3. bundle_deals     - gains a description and an explicit cover product so a
--                       curated bundle can be shown like a product.

-- ---------------------------------------------------------------- add-ons

create table if not exists public.product_addons (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),
  price_usd numeric(10,2) not null check (price_usd > 0 and price_usd <= 10000),
  -- null = derive from the USD price with the same DevEx rounding the product
  -- form uses (see _shared/addons.ts devexRobux).
  price_robux numeric(12,0) check (price_robux is null or price_robux > 0),
  -- Private storage path of the deliverable (e.g. the unwatermarked
  -- thumbnail), in the same private product-files bucket as product files.
  -- Never exposed to the browser: see the column grant below.
  storage_path text,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  has_file boolean generated always as (storage_path is not null) stored,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_addons_product_id_idx on public.product_addons(product_id);

alter table public.product_addons enable row level security;

do $$ begin
  create policy "product_addons_select_public" on public.product_addons
    for select using (
      active = true
      and exists (select 1 from public.products p where p.id = product_addons.product_id and p.is_active = true)
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "product_addons_select_admin" on public.product_addons
    for select using (public.is_admin());
exception when duplicate_object then null;
end $$;

-- storage_path is the private download path: browsers may read everything
-- else. Writes only ever happen through admin-upsert-product (service role).
revoke all on public.product_addons from public, anon, authenticated;
grant select (id, product_id, title, description, price_usd, price_robux, file_name, has_file, sort_order, active, created_at, updated_at)
  on public.product_addons to anon, authenticated;

-- ------------------------------------------------------------ order add-ons

create table if not exists public.order_addons (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_slug text not null,
  addon_id uuid references public.product_addons(id) on delete set null,
  title text not null,
  description text not null default '',
  unit_price_usd numeric(10,2) not null,
  unit_price_robux numeric(12,0),
  -- Setup-style add-ons need the buyer to open a Discord ticket before any
  -- work starts. Decided server-side from the title (see needsTicket()).
  needs_ticket boolean not null default false,
  storage_path text,
  file_name text,
  created_at timestamptz not null default now()
);

create index if not exists order_addons_order_id_idx on public.order_addons(order_id);

alter table public.order_addons enable row level security;

do $$ begin
  create policy "order_addons_select_own" on public.order_addons
    for select using (
      exists (select 1 from public.orders o where o.id = order_addons.order_id and o.user_id = auth.uid())
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "order_addons_select_admin" on public.order_addons
    for select using (public.is_admin());
exception when duplicate_object then null;
end $$;

-- A buyer may read their own add-on rows but never the private file path.
revoke all on public.order_addons from public, anon, authenticated;
grant select (id, order_id, product_id, product_slug, addon_id, title, description, unit_price_usd, unit_price_robux, needs_ticket, file_name, created_at)
  on public.order_addons to authenticated;

-- ---------------------------------------------------------------- bundles

alter table public.bundle_deals
  add column if not exists description text,
  add column if not exists cover_slug text;

alter table public.bundle_deals drop constraint if exists bundle_deals_description_len;
alter table public.bundle_deals
  add constraint bundle_deals_description_len check (description is null or char_length(description) <= 300);
