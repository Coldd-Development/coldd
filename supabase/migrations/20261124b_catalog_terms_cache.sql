-- Site speed (2026-11-24), part 2: catalog_signal_terms() (about 130 ms, called by
-- every page and inside get_checkout_cross_sell) is cached the same way as
-- catalog_demand_signals: the 10-minute refresh job now fills both tables.

create table if not exists public.catalog_terms_cache (
  product_id uuid primary key,
  product_slug text,
  terms text[] not null default '{}'
);
alter table public.catalog_terms_cache enable row level security;

alter function public.catalog_signal_terms() rename to catalog_signal_terms_compute;
revoke execute on function public.catalog_signal_terms_compute() from public, anon, authenticated;

create or replace function public.catalog_signal_terms()
returns table(product_id uuid, product_slug text, terms text[])
language sql
stable
security definer
set search_path = public
as $$
  select c.product_id, c.product_slug, c.terms from public.catalog_terms_cache c
  union all
  select s.product_id, s.product_slug, s.terms from public.catalog_signal_terms_compute() s
  where not exists (select 1 from public.catalog_terms_cache);
$$;
grant execute on function public.catalog_signal_terms() to anon, authenticated;

create or replace function public.refresh_catalog_demand_cache()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  drop table if exists _demand;
  create temp table _demand on commit drop as select * from public.catalog_demand_signals_compute();
  delete from public.catalog_demand_cache where product_slug not in (select product_slug from _demand where product_slug is not null);
  insert into public.catalog_demand_cache (product_slug, bbb_rank, views_rank, computed_at)
  select product_slug, coalesce(bbb_rank, 0), coalesce(views_rank, 0), now() from _demand where product_slug is not null
  on conflict (product_slug) do update set bbb_rank = excluded.bbb_rank, views_rank = excluded.views_rank, computed_at = excluded.computed_at;

  drop table if exists _terms;
  create temp table _terms on commit drop as select * from public.catalog_signal_terms_compute();
  delete from public.catalog_terms_cache where product_id not in (select product_id from _terms where product_id is not null);
  insert into public.catalog_terms_cache (product_id, product_slug, terms)
  select product_id, product_slug, coalesce(terms, '{}') from _terms where product_id is not null
  on conflict (product_id) do update set product_slug = excluded.product_slug, terms = excluded.terms;
end;
$$;
revoke execute on function public.refresh_catalog_demand_cache() from public, anon, authenticated;

select public.refresh_catalog_demand_cache();
