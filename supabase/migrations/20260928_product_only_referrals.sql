-- Referrals move from account-wide ("whoever's link you signed up
-- through earns 20% of every purchase you ever make") to purely
-- per-product ("earn 20% only on the exact product a buyer used your
-- link for"). The account-level relationship and its accrued
-- clicks/signups are dropped entirely, not preserved - a fresh start,
-- decided deliberately rather than left to keep quietly earning.
alter table public.profiles drop column if exists referred_by;
alter table public.profiles drop column if exists referral_clicks;
drop index if exists public.profiles_referred_by_idx;

-- Per-product attribution lives on the order itself, captured at checkout
-- time exactly like campaign_code already is - not a separate ledger.
-- Earnings are computed on read (20% of the matching order_items row,
-- only when ref_product_slug actually matches one of the items bought),
-- so there's nothing to keep in sync if an order changes.
alter table public.orders add column if not exists referrer_id uuid references auth.users(id);
alter table public.orders add column if not exists ref_product_slug text;

create index if not exists orders_referrer_id_idx on public.orders(referrer_id);
