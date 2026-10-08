-- Fully automatic keywords: no hand-written stop-word lists.
-- Filler is detected from the data: a word is "common" when it appears in more than 10% of a large
-- reference corpus (every product's title+description plus every BuiltByBit listing's title+summary,
-- ~1000 documents). Common words ("and", "with", "this", "roblox", "pack", ...) are never keywords.
-- A keyword must also recur in at least 2 products but not in more than 40% of them, so one-off
-- flavour text is dropped too. Both the catalog keyword mining and the BuiltByBit similarity work
-- this way and update themselves as products and listings are added.

create or replace function public.catalog_signal_terms()
returns table(product_id uuid, product_slug text, terms text[])
language sql
stable
security definer
set search_path to 'public'
as $$
  with base as (
    select p.id, p.slug,
      regexp_split_to_array(
        regexp_replace(lower(coalesce(p.title, '') || ' ' || coalesce(p.description, '')), '[^a-z0-9]+', ' ', 'g'),
        '\s+'
      ) as words
    from products p
    where p.is_active
  ),
  corpus as (
    select regexp_split_to_table(lower(regexp_replace(coalesce(p.title, '') || ' ' || coalesce(p.description, ''), '[^a-zA-Z0-9]+', ' ', 'g')), '\s+') as w, p.id::text as d
    from products p where p.is_active
    union all
    select regexp_split_to_table(lower(regexp_replace(coalesce(r.title, '') || ' ' || coalesce(r.summary, ''), '[^a-zA-Z0-9]+', ' ', 'g')), '\s+'), 'r' || r.resource_id::text
    from bbb2_resources r
  ),
  corpus_df as (select w, count(distinct d) as df from corpus where length(w) > 2 group by w),
  corpus_n as (select greatest(count(distinct d), 1) as n from corpus),
  common as (
    select cd.w from corpus_df cd, corpus_n cn where cn.n >= 50 and cd.df > 0.10 * cn.n
  ),
  tokens as (
    select b.id, b.slug, t.w, t.ord
    from base b, unnest(b.words) with ordinality as t(w, ord)
    where length(t.w) > 2 and t.w not in (select w from common)
  ),
  unigrams as (select id, slug, w as term from tokens),
  bigrams as (
    select a.id, a.slug, a.w || ' ' || b.w as term
    from tokens a join tokens b on b.id = a.id and b.ord = a.ord + 1
  ),
  all_terms as (
    select id, slug, term from unigrams
    union all
    select id, slug, term from bigrams
  ),
  df as (select term, count(distinct id) as doc_freq from all_terms group by term),
  total as (select count(*) as n from base),
  significant as (
    select at.id, at.slug, at.term
    from all_terms at
    join df on df.term = at.term
    cross join total
    where df.doc_freq >= 2 and df.doc_freq <= greatest(2, total.n * 0.4)
  )
  select id as product_id, slug as product_slug, coalesce(array_agg(distinct term), '{}') as terms
  from significant
  group by id, slug;
$$;

-- BuiltByBit similarity: tokens are the words of each title; a word is ignored when it is common in
-- the same reference corpus (more than 10% of documents).
create or replace function public.catalog_demand_signals()
returns table(product_slug text, bbb_rank numeric, views_rank numeric)
language sql
stable
security definer
set search_path = public
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
