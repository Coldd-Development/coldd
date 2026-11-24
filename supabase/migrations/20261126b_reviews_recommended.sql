-- Creator Store reviews are a thumbs up or down, not stars: stars may be empty and
-- recommended holds the thumb (null on BuiltByBit and coldd.dev reviews). Product ratings
-- average stars only (avg ignores nulls).
alter table public.reviews alter column stars drop not null;
alter table public.reviews add column if not exists recommended boolean;

-- When admin-bbb-v2-sync last read BuiltByBit reviews (every 10 minutes).
alter table public.bbb2_state add column if not exists reviews_at timestamptz;

-- creator-store-sync keeps its review timer in its own row.
alter table public.platform_sync_state drop constraint if exists platform_sync_state_platform_check;
alter table public.platform_sync_state add constraint platform_sync_state_platform_check
  check (platform = any (array['clearlydev', 'parcel', 'creatorstore', 'payhip', 'creatorstore-reviews']));
