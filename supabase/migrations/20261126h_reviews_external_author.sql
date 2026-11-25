-- Imported reviews remember who left them on the platform (Parcel: roblox:<id>), so a reviewer's
-- newer review on the same product replaces their older one (parcel_feed.ts keepNewestPerReviewer).
alter table public.reviews add column if not exists external_author text;
comment on column public.reviews.external_author is 'Imported reviews: who left it on the platform (Parcel: roblox:<id>), so a reviewer''s newer review on the same product replaces the older one.';
