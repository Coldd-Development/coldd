-- Rebalance of the shared relevance engine: matching is driven by KEYWORDS and CATEGORY.
--   keywords (100): shared recurring words/phrases mined from the catalogue's own titles and
--                   descriptions (catalog_signal_terms), idf weighted, as coverage of the context's terms.
--   category  (55): same category as something in the context.
--   style tags(45): shared subcategory tags (stud-style, sci-fi, medieval, ...), idf weighted.
--   session (20+15), demand (20+8+10), quality (<=12) and price fit (8) are unchanged.
-- No hand-written genre list is used anywhere in this function.
drop function if exists public.get_checkout_cross_sell(text[], integer);
drop function if exists public.get_checkout_cross_sell(text[], integer, jsonb);
drop function if exists public.get_checkout_cross_sell(text[], integer, jsonb, uuid);

create function public.get_checkout_cross_sell(
  p_slugs text[],
  p_limit integer default 3,
  p_interest jsonb default '{}'::jsonb,
  p_user_id uuid default null
)
returns table (
  product_slug   text,
  list_price_usd numeric,
  deal_price_usd numeric,
  score          numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with active as (
    select p.id, p.slug, p.platform, p.cat, p.price_usd, p.rating, p.reviews_count,
           coalesce(array(
             select distinct btrim(t) from unnest(string_to_array(lower(coalesce(p.subcat, '')), ',')) t where btrim(t) <> ''
           ), '{}') as tags
    from products p where p.is_active
  ),
  n as (select greatest(count(*), 1)::numeric as n from active),
  -- style tags: idf over the active catalogue
  tag_df as (
    select t as tag, count(*)::numeric as df from active, unnest(active.tags) t group by t
  ),
  tag_w as (select tag, ln(1 + (select n from n) / df) as w from tag_df),
  ctx as (select a.* from active a where a.slug = any(p_slugs)),
  ctx_tags as (select distinct t as tag from ctx, unnest(ctx.tags) t),
  ctx_tag_total as (select coalesce(sum(w), 0) as total from tag_w join ctx_tags using (tag)),
  -- genre terms: idf over the catalogue's own recurring terms
  terms as (select product_id, unnest(terms) as term from public.catalog_signal_terms()),
  term_df as (select term, count(distinct product_id)::numeric as df from terms group by term),
  term_w as (select term, ln(1 + (select n from n) / df) as w from term_df),
  ctx_terms as (select distinct term from terms where product_id in (select id from ctx)),
  ctx_term_total as (select coalesce(sum(w), 0) as total from term_w join ctx_terms using (term)),
  owned as (
    select distinct oi.product_id
    from order_items oi join orders o on o.id = oi.order_id and o.status = 'paid'
    where (case when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid()) else auth.uid() end) is not null
      and o.user_id = (case when auth.role() = 'service_role' then coalesce(p_user_id, auth.uid()) else auth.uid() end)
  ),
  signals as (select * from public.catalog_demand_signals()),
  revrank as (select * from public.catalog_revenue_rank()),
  ctx_avg as (select coalesce(avg(price_usd), 0) as avg_price from ctx),
  sess_cats as (
    select key as cat, (value)::numeric as c from jsonb_each_text(coalesce(p_interest -> 'cats', '{}'::jsonb))
  ),
  sess_cat_max as (select greatest(coalesce(max(c), 0), 1) as m from sess_cats),
  sess_terms as (
    select key as term, (value)::numeric as c from jsonb_each_text(coalesce(p_interest -> 'terms', '{}'::jsonb))
  ),
  cand as (
    select a.id, a.slug, a.price_usd, a.cat, a.rating, a.reviews_count,
      pl.min_sale_usd,
      coalesce(pl.max_discount_pct, 0) as max_discount_pct,
      coalesce(pl.disallow_sales, false) as disallow_sales,
      -- style: weighted coverage of the context's tags that this candidate also has
      case when (select total from ctx_tag_total) > 0 then
        coalesce((select sum(tw.w) from tag_w tw join ctx_tags ct using (tag) where tw.tag = any(a.tags)), 0)
        / (select total from ctx_tag_total)
      else 0 end as style,
      case when (select total from ctx_term_total) > 0 then
        coalesce((select sum(w.w) from terms t join term_w w using (term) join ctx_terms ct using (term) where t.product_id = a.id), 0)
        / (select total from ctx_term_total)
      else 0 end as genre,
      case when a.cat in (select cat from ctx) then 1 else 0 end as samecat,
      coalesce((select c from sess_cats sc where sc.cat = a.cat), 0) / (select m from sess_cat_max) as sess_cat,
      least(1, coalesce((select sum(st.c) from sess_terms st join terms t on t.term = st.term where t.product_id = a.id), 0) / 6.0) as sess_terms,
      coalesce((select s.bbb_rank from signals s where s.product_slug = a.slug), 0) as bbb,
      coalesce((select s.views_rank from signals s where s.product_slug = a.slug), 0) as vw,
      coalesce((select r.rank from revrank r where r.product_slug = a.slug), 0) as rev,
      case when (select avg_price from ctx_avg) > 0
             and a.price_usd between 0.4 * (select avg_price from ctx_avg) and 2.5 * (select avg_price from ctx_avg)
           then 1 else 0 end as pricefit
    from active a
    left join product_legal pl on pl.product_id = a.id
    where a.slug <> all(p_slugs)
      and a.platform in (select platform from ctx)
      and a.id not in (select product_id from owned)
  ),
  scored as (
    select c.*,
      45 * least(1, c.style)
      + 100 * least(1, c.genre)
      + 55 * c.samecat
      + 20 * c.sess_cat
      + 15 * c.sess_terms
      + 20 * c.bbb + 8 * c.vw + 10 * c.rev
      + least(12, (coalesce(c.rating, 0) * 2 + ln(1 + coalesce(c.reviews_count, 0))) * 1.2)
      + 8 * c.pricefit as score
    from cand c
  ),
  priced as (
    select s.*,
      s.price_usd as list_price_usd,
      case
        when s.disallow_sales then s.price_usd
        else greatest(
          round(s.price_usd * 0.90, 2),
          coalesce(s.min_sale_usd, 0),
          case when s.max_discount_pct > 0 then round(s.price_usd * (1 - s.max_discount_pct / 100.0), 2) else 0 end
        )
      end as deal_price_usd
    from scored s
  )
  select slug as product_slug, list_price_usd, least(deal_price_usd, list_price_usd) as deal_price_usd, round(score::numeric, 3) as score
  from priced
  order by score desc
  limit greatest(1, coalesce(p_limit, 3));
$$;

grant execute on function public.get_checkout_cross_sell(text[], integer, jsonb, uuid) to anon, authenticated;
notify pgrst, 'reload schema';


-- Dashboard "Recommended for you": same idea, keyword (recurring term) match with what the user bought,
-- plus category, instead of the old fixed genre list.
create or replace function public.get_recommended_for_user(p_user_id uuid, p_limit integer default 8)
returns table(product_slug text, score numeric)
language sql
stable
security definer
set search_path to 'public'
as $$
  with owned as (
    select distinct oi.product_id
    from order_items oi
    join orders o on o.id = oi.order_id and o.status = 'paid'
    where o.user_id = p_user_id
  ),
  bought_cats as (
    select distinct p.platform, p.cat
    from owned join products p on p.id = owned.product_id
  ),
  user_terms as (
    select distinct term
    from public.catalog_signal_terms() cst
    join owned on owned.product_id = cst.product_id
    cross join lateral unnest(cst.terms) as term
  ),
  cand_terms as (
    select cst.product_id, count(*) filter (where ut.term is not null) as shared, count(*) as total
    from public.catalog_signal_terms() cst
    cross join lateral unnest(cst.terms) as t(term)
    left join user_terms ut on ut.term = t.term
    group by cst.product_id
  ),
  signals as (select * from public.catalog_demand_signals()),
  revenue as (select * from public.catalog_revenue_rank())
  select p.slug as product_slug,
    (
      (case when p.priority then 200 else 0 end)
      + 140 * least(1, coalesce(ct.shared, 0)::numeric / 6.0)
      + 55
      + 20 * coalesce((select s.bbb_rank from signals s where s.product_slug = p.slug), 0)
      + 8 * coalesce((select s.views_rank from signals s where s.product_slug = p.slug), 0)
      + 10 * coalesce((select r.rank from revenue r where r.product_slug = p.slug), 0)
      + least(12, (coalesce(p.rating, 0) * 2 + ln(1 + coalesce(p.reviews_count, 0))) * 1.2)
      + (case when p.was_price > p.price_usd and p.was_price > 0
              then 15 + (1 - p.price_usd / p.was_price) * 100 * 0.3 else 0 end)
      + greatest(0, 20 - extract(epoch from (now() - p.created_at)) / 86400 / 3)
      + ln(1 + p.price_usd) * 4
      + (case when p.resell_available then 8 else 0 end)
    )::numeric as score
  from products p
  join bought_cats bc on bc.platform = p.platform and bc.cat = p.cat
  left join cand_terms ct on ct.product_id = p.id
  where p.is_active
    and p.id not in (select product_id from owned)
  order by score desc
  limit p_limit;
$$;
grant execute on function public.get_recommended_for_user(uuid, integer) to authenticated;
