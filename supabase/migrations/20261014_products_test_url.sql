-- Optional "try it in Roblox" link per product. When set, the product page FAQ
-- shows a "Can I test this game out in Roblox?" answer pointing at it.
alter table public.products add column if not exists test_url text;
comment on column public.products.test_url is
  'Public https link (Roblox experience) where buyers can try the product. NULL/empty hides the FAQ entry.';

-- anon/authenticated read products through explicit column grants.
grant select (test_url) on public.products to anon, authenticated;
