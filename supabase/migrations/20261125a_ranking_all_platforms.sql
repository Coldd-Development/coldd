-- Shop ranking (2026-11-25): sales on every platform count. sales_rank is each
-- product's recent sales (a sale halves in weight every 30 days, last 180 days) on
-- coldd.dev, BuiltByBit (listings with the product's title or an alias of it), the
-- Creator Store, ClearlyDev, Payhip and Parcel (platform_sales: by product_id, else by
-- name; Parcel orders from the Discord bot count as soon as they land there), on a
-- log scale against the best seller. bbb_rank (BuiltByBit demand incl. similar
-- listings) and views_rank are kept as they were.
alter table public.catalog_demand_cache add column if not exists sales_rank numeric not null default 0;

drop function if exists public.catalog_demand_signals();
drop function if exists public.catalog_demand_signals_compute();

create function public.catalog_demand_signals_compute()
returns table(product_slug text, bbb_rank numeric, views_rank numeric, sales_rank numeric)
language sql
stable
security definer
set search_path to 'public'
as $$
  with titles as (
    select 'p:' || slug as id, coalesce(title, '') || ' ' || coalesce(description, '') as title from products where is_active
    union all
    select 'r:' || resource_id::text, coalesce(title, '') || ' ' || coalesce(summary, '') from bbb2_resources
  ),
  title_tokens as (
    select id, t as tok
    from titles, lateral (select distinct x as t from regexp_split_to_table(lower(title), '[^a-z0-9]+') x where length(x) >= 3) s
  ),
  tok_df as (select tok, count(*)::numeric as df from title_tokens group by tok),
  tot as (select greatest(count(*), 1)::numeric as n from titles),
  common(w) as (
    select tok from tok_df, tot where tok_df.df > 0.10 * tot.n and tot.n >= 50
  ),
  res as (
    select r.resource_id,
           lower(regexp_replace(r.title, '[^a-zA-Z0-9]+', '', 'g')) as k,
           array(select distinct t from regexp_split_to_table(lower(r.title), '[^a-z0-9]+') t
                 where length(t) >= 3 and t not in (select w from common)) as toks
    from bbb2_resources r
  ),
  wt as (
    select p.resource_id,
           sum(power(0.5, extract(epoch from (now() - p.created_at)) / 86400.0 / 30.0)) as w
    from bbb2_purchases p
    where p.created_at > now() - interval '120 days'
    group by p.resource_id
  ),
  rw as (select res.k, res.toks, wt.w from res join wt using (resource_id)),
  prod as (
    select pr.slug,
           lower(regexp_replace(pr.title, '[^a-zA-Z0-9]+', '', 'g')) as k,
           array(select distinct t from regexp_split_to_table(lower(pr.title), '[^a-z0-9]+') t
                 where length(t) >= 3 and t not in (select w from common)) as toks
    from products pr
    where pr.is_active
  ),
  bbb as (
    select prod.slug,
           coalesce(sum(rw.w) filter (where rw.k = prod.k), 0) as direct,
           coalesce(sum(
             rw.w * 0.5 *
             cardinality(array(select unnest(prod.toks) intersect select unnest(rw.toks)))::numeric /
             greatest(1, least(cardinality(prod.toks), cardinality(rw.toks)))
           ) filter (where rw.k <> prod.k and cardinality(array(select unnest(prod.toks) intersect select unnest(rw.toks))) > 0), 0) as theme
    from prod left join rw on true
    group by prod.slug
  ),
  vw as (
    select regexp_replace(regexp_replace(path, '^/product/', ''), '/$', '') as slug, count(*) as n
    from page_views
    where path like '/product/%' and created_at > now() - interval '14 days'
    group by 1
  ),
  -- Every name a product sells under: its title, and the aliases that point to it.
  names as (
    select pr.slug, prod.k from products pr join prod on prod.slug = pr.slug
    union
    select pr.slug, lower(regexp_replace(a.alias, '[^a-zA-Z0-9]+', '', 'g'))
    from product_name_aliases a
    join products pr on pr.is_active and lower(regexp_replace(pr.title, '[^a-zA-Z0-9]+', '', 'g')) = lower(regexp_replace(a.canonical, '[^a-zA-Z0-9]+', '', 'g'))
  ),
  sales as (
    -- coldd.dev: paid orders (no tests, no free grants)
    select p.slug, coalesce(o.paid_at, o.created_at) as t
    from order_items oi
    join orders o on o.id = oi.order_id and o.status = 'paid' and not coalesce(o.is_test, false) and coalesce(o.source, '') <> 'granted'
    join products p on p.id = oi.product_id
    union all
    -- BuiltByBit: purchases of a listing sold under one of the product's names
    select nm.slug, bp.created_at
    from bbb2_purchases bp
    join bbb2_resources r on r.resource_id = bp.resource_id
    join names nm on nm.k = lower(regexp_replace(r.title, '[^a-zA-Z0-9]+', '', 'g'))
    union all
    -- Creator Store, ClearlyDev, Payhip, Parcel: by product id, else by each name in the order
    select coalesce(pp.slug, nm.slug), s.sold_at
    from platform_sales s
    left join products pp on pp.id = s.product_id
    left join lateral (select trim(x) as n from regexp_split_to_table(coalesce(s.product_name, ''), ',\s+') x) parts on s.product_id is null
    left join names nm on s.product_id is null and nm.k = lower(regexp_replace(parts.n, '[^a-zA-Z0-9]+', '', 'g'))
    where coalesce(s.status, '') <> 'refunded'
  ),
  sw as (
    select slug, sum(power(0.5, extract(epoch from (now() - t)) / 86400.0 / 30.0)) as w
    from sales
    where slug is not null and t > now() - interval '180 days'
    group by slug
  ),
  m as (
    select bbb.slug,
           0.7 * ln(1 + bbb.direct) + 0.3 * ln(1 + bbb.theme) as b,
           ln(1 + coalesce(vw.n, 0)) as v,
           ln(1 + coalesce(sw.w, 0)) as s
    from bbb
    left join vw on vw.slug = bbb.slug
    left join sw on sw.slug = bbb.slug
  )
  select m.slug,
         round((m.b / nullif(max(m.b) over (), 0))::numeric, 4),
         round((m.v / nullif(max(m.v) over (), 0))::numeric, 4),
         round((m.s / nullif(max(m.s) over (), 0))::numeric, 4)
  from m;
$$;

create function public.catalog_demand_signals()
returns table(product_slug text, bbb_rank numeric, views_rank numeric, sales_rank numeric)
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.product_slug, c.bbb_rank, c.views_rank, c.sales_rank from public.catalog_demand_cache c
  union all
  select s.product_slug, s.bbb_rank, s.views_rank, s.sales_rank from public.catalog_demand_signals_compute() s
  where not exists (select 1 from public.catalog_demand_cache);
$$;
grant execute on function public.catalog_demand_signals() to anon, authenticated;
revoke all on function public.catalog_demand_signals_compute() from public, anon, authenticated;

create or replace function public.refresh_catalog_demand_cache()
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  drop table if exists _demand;
  create temp table _demand on commit drop as select * from public.catalog_demand_signals_compute();
  delete from public.catalog_demand_cache where product_slug not in (select product_slug from _demand where product_slug is not null);
  insert into public.catalog_demand_cache (product_slug, bbb_rank, views_rank, sales_rank, computed_at)
  select product_slug, coalesce(bbb_rank, 0), coalesce(views_rank, 0), coalesce(sales_rank, 0), now() from _demand where product_slug is not null
  on conflict (product_slug) do update set bbb_rank = excluded.bbb_rank, views_rank = excluded.views_rank, sales_rank = excluded.sales_rank, computed_at = excluded.computed_at;

  drop table if exists _terms;
  create temp table _terms on commit drop as select * from public.catalog_signal_terms_compute();
  delete from public.catalog_terms_cache where product_id not in (select product_id from _terms where product_id is not null);
  insert into public.catalog_terms_cache (product_id, product_slug, terms)
  select product_id, product_slug, coalesce(terms, '{}') from _terms where product_id is not null
  on conflict (product_id) do update set product_slug = excluded.product_slug, terms = excluded.terms;
end;
$$;

select public.refresh_catalog_demand_cache();
