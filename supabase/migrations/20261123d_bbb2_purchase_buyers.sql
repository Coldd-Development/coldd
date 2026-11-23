-- BuiltByBit buyers on each purchase (2026-11-23). The v2 purchases endpoint
-- returns the buyer when asked with ?with=Buyer; admin-bbb-v2-sync now asks and
-- stores who bought it, so the admin Orders page can show a buyer name.
alter table public.bbb2_purchases add column if not exists buyer_id bigint;
alter table public.bbb2_purchases add column if not exists buyer_name text;
alter table public.bbb2_purchases add column if not exists buyer_avatar text;
alter table public.bbb2_purchases add column if not exists external_tid text;
