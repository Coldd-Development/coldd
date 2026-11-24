-- Reviews from BuiltByBit and the Creator Store, taken automatically (admin-bbb-v2-sync and
-- creator-store-sync, through _shared/platform_reviews.ts).
--   source        'BuiltByBit' / 'Creator Store' (coldd.dev's own stay 'Website')
--   external_id   'bbb:<review_id>' / 'cs:<comment id>', so a review is stored once
--   listing_name  the platform listing it was left on (matched to a product by name)
--   listing_ref   BuiltByBit resource id / Roblox asset id
--   hidden_reason 'unmatched' while no coldd.dev product matches it (status hidden); every sync
--                 run re-tries the match and publishes it when one appears
--   auto_imported true for these synced reviews
alter table public.reviews
  add column if not exists external_id text,
  add column if not exists listing_name text,
  add column if not exists listing_ref text,
  add column if not exists hidden_reason text,
  add column if not exists auto_imported boolean not null default false;
create unique index if not exists reviews_external_id_key on public.reviews (external_id);
create index if not exists reviews_unmatched_idx on public.reviews (hidden_reason) where hidden_reason is not null;
