-- Site speed (2026-11-24): catalog_demand_signals() took about 3.3 s per call
-- (every catalogue product against every BuiltByBit listing sold in 120 days,
-- keyword overlap for each pair) and ran on every catalogue load, plus inside
-- get_checkout_cross_sell (3.6 s). Its numbers only move slowly, so they are now
-- worked out every 10 minutes into a small table and the function reads that.
-- Same columns, same values (up to 10 minutes old).

create table if not exists public.catalog_demand_cache (
  product_slug text primary key,
  bbb_rank numeric not null default 0,
  views_rank numeric not null default 0,
  computed_at timestamptz not null default now()
);
alter table public.catalog_demand_cache enable row level security;
-- No policies: only the security-definer functions below read or write it.

-- The original calculation keeps its body under a new name.
alter function public.catalog_demand_signals() rename to catalog_demand_signals_compute;
revoke execute on function public.catalog_demand_signals_compute() from public, anon, authenticated;

create or replace function public.refresh_catalog_demand_cache()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  create temp table _demand on commit drop as select * from public.catalog_demand_signals_compute();
  delete from public.catalog_demand_cache where product_slug not in (select product_slug from _demand where product_slug is not null);
  insert into public.catalog_demand_cache (product_slug, bbb_rank, views_rank, computed_at)
  select product_slug, coalesce(bbb_rank, 0), coalesce(views_rank, 0), now() from _demand where product_slug is not null
  on conflict (product_slug) do update set bbb_rank = excluded.bbb_rank, views_rank = excluded.views_rank, computed_at = excluded.computed_at;
end;
$$;
revoke execute on function public.refresh_catalog_demand_cache() from public, anon, authenticated;

-- Same name and shape as before, so the site and get_checkout_cross_sell are unchanged.
-- Falls back to the full calculation only while the cache is still empty.
create or replace function public.catalog_demand_signals()
returns table(product_slug text, bbb_rank numeric, views_rank numeric)
language sql
stable
security definer
set search_path = public
as $$
  select c.product_slug, c.bbb_rank, c.views_rank from public.catalog_demand_cache c
  union all
  select s.product_slug, s.bbb_rank, s.views_rank from public.catalog_demand_signals_compute() s
  where not exists (select 1 from public.catalog_demand_cache);
$$;
grant execute on function public.catalog_demand_signals() to anon, authenticated;

select public.refresh_catalog_demand_cache();

select cron.schedule('catalog-demand-cache', '*/10 * * * *', 'select public.refresh_catalog_demand_cache()');
