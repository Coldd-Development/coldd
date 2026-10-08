-- Normalised (0..1) demand signals per product for catalog ranking and recommendations.
-- Returns only ranks, never raw counts or dollars, so the public API does not leak real numbers
-- (same rule as catalog_revenue_rank).
--   bbb_rank   : BuiltByBit sales of the same listing (direct title match, strong) plus sales of
--                similar listings (shared keywords, weaker), recency weighted (30-day half-life,
--                120-day window), log-scaled and divided by the best product.
--   views_rank : on-site product page views over the last 14 days, log-scaled, divided by the best.
create or replace function public.catalog_demand_signals()
returns table(product_slug text, bbb_rank numeric, views_rank numeric)
language sql
stable
security definer
set search_path = public
as $$
  with stop(w) as (
    select unnest(array['the','and','pack','kit','set','bundle','asset','assets','system','template','roblox','for','with','map','combat'])
  ),
  res as (
    select r.resource_id,
           lower(regexp_replace(r.title, '[^a-zA-Z0-9]+', '', 'g')) as k,
           array(select distinct t from regexp_split_to_table(lower(r.title), '[^a-z0-9]+') t
                 where length(t) >= 3 and t not in (select w from stop)) as toks
    from bbb2_resources r
  ),
  wt as (
    select p.resource_id,
           sum(power(0.5, extract(epoch from (now() - p.created_at)) / 86400.0 / 30.0)) as w
    from bbb2_purchases p
    where p.created_at > now() - interval '120 days'
    group by p.resource_id
  ),
  rw as (
    select res.k, res.toks, wt.w from res join wt using (resource_id)
  ),
  prod as (
    select pr.slug,
           lower(regexp_replace(pr.title, '[^a-zA-Z0-9]+', '', 'g')) as k,
           array(select distinct t from regexp_split_to_table(lower(pr.title), '[^a-z0-9]+') t
                 where length(t) >= 3 and t not in (select w from stop)) as toks
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
  m as (
    select bbb.slug,
           0.7 * ln(1 + bbb.direct) + 0.3 * ln(1 + bbb.theme) as b,
           ln(1 + coalesce(vw.n, 0)) as v
    from bbb left join vw on vw.slug = bbb.slug
  )
  select m.slug,
         round((m.b / nullif(max(m.b) over (), 0))::numeric, 4),
         round((m.v / nullif(max(m.v) over (), 0))::numeric, 4)
  from m;
$$;
grant execute on function public.catalog_demand_signals() to anon, authenticated;
