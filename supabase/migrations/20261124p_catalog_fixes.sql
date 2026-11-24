-- Admin data fixes (2026-11-24).
-- 1) Categories for products that are not on coldd.dev: product_name_aliases can carry a
--    category ("Gaza Strip" sells on ClearlyDev only and is a map).
alter table public.product_name_aliases add column if not exists category text;
insert into public.product_name_aliases (alias, canonical, category)
select 'Gaza Strip', 'Gaza Strip', 'Maps'
where not exists (select 1 from public.product_name_aliases where lower(alias) = 'gaza strip');
update public.product_name_aliases set category = 'Maps' where lower(alias) = 'gaza strip';

-- 2) Marketplace listings that were uploaded by mistake: their sales are left out of the
--    admin and the syncs never write them back. "Fire VFX Asset Pack" on the Creator
--    Store was a duplicate of "250+ Fire VFX Asset Pack" (its 2 sales, 17 and 21 Nov
--    2026, US$3.99 each, are removed).
create table if not exists public.platform_sale_ignores (
  platform text not null,
  product_name text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists platform_sale_ignores_key on public.platform_sale_ignores (platform, lower(product_name));
alter table public.platform_sale_ignores enable row level security;
insert into public.platform_sale_ignores (platform, product_name)
values ('creatorstore', 'Fire VFX Asset Pack') on conflict do nothing;
delete from public.platform_sales where platform = 'creatorstore' and product_name = 'Fire VFX Asset Pack';

-- 3) BuiltByBit add-on purchases: the add-on's title, read with the purchase
--    (with=Addon also gives the add-on's listing). A full purchases re-read fills
--    the 28 add-on purchases that had no listing.
alter table public.bbb2_purchases add column if not exists addon_title text;
update public.bbb2_state set purchases_full_at = null where id = true;
