-- Shared relevance engine: "given what this person is looking at / buying, which products are
-- they most likely to buy next?" Used by checkout "Add to your order", the post-purchase upsell
-- and (later) bundles, spend-tier nudges and emails.
--
-- Biggest weights go to STYLE and GENRE match, because that is what people actually buy by
-- (someone who bought a stud-style map wants more stud-style products):
--   style  (100): shared subcategory tags (stud-style, sci-fi, medieval, low-poly, ...), each tag
--                 weighted by how rare it is (idf) and measured as coverage of the context's tags,
--                 so matching two of two tags beats matching one of two, and a rare tag beats a
--                 common one.
--   genre   (55): shared recurring words/phrases from titles+descriptions (catalog_signal_terms),
--                 idf weighted, same coverage idea.
--   category (22): same category as something in the context.
--   session (20+15): the visitor's own browsing this session (categories and words they viewed,
--                 searched or added), sent by the browser as p_interest.
--   demand  (20+8+10): BuiltByBit sales (same + similar listings), on-site views, on-site revenue.
--   quality  (<=12): rating and review count.
--   price fit (8): within 0.4x to 2.5x of the context's average price.
-- Products the signed-in user already owns, and anything already in the context, are excluded.
-- The suggested deal price is 10% off, never below product_legal.min_sale_usd or the product's
-- max_discount_pct cap, and no discount at all when disallow_sales is set (same rules as before).

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
      100 * least(1, c.style)
      + 55 * least(1, c.genre)
      + 22 * c.samecat
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
