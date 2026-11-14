-- Store every carousel image url of a BuiltByBit listing, not only the count
-- (filled by admin-bbb-v2-sync).
alter table public.bbb2_resources add column if not exists carousel_image_urls jsonb not null default '[]'::jsonb;
