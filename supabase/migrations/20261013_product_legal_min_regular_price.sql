-- product_legal: separate minimum regular price from minimum sale price
--
--   min_regular_usd / min_regular_robux  - the lowest the normal list price may be set to
--   min_sale_usd / min_sale_robux        - the lowest any discount may bring a unit to
--   max_discount_pct                     - cap on the discount percentage (alternative to a sale floor)
--
-- Until now min_sale_* also blocked the list price from being saved below it, so existing rows
-- copy their sale floor into the new regular floor to keep that protection exactly as it was.

alter table public.product_legal
  add column if not exists min_regular_usd numeric(10,2) not null default 0,
  add column if not exists min_regular_robux numeric(10,2) not null default 0;

update public.product_legal
set min_regular_usd = min_sale_usd,
    min_regular_robux = min_sale_robux
where min_regular_usd = 0 and min_regular_robux = 0;
