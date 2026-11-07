-- Homepage "Bundle & save": admins pick which curated bundles show on the homepage and in what
-- order (admin > Content > Homepage), the same way products.featured / featured_order work.
-- The public curated-bundle read policy already covers every column, so nothing else changes.

alter table public.bundle_deals
  add column if not exists home_featured boolean not null default false,
  add column if not exists home_order integer not null default 0;
