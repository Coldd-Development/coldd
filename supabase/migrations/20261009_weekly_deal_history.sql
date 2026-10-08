-- One row per product per weekly-deal run. The deal algorithm reads finished rows to learn
-- which discount depth earns the most revenue per visitor (Thompson sampling), so the
-- views / units / revenue columns are filled in when the NEXT run closes the row.
create table if not exists public.weekly_deal_history (
  id bigint generated always as identity primary key,
  product_id uuid not null references public.products(id) on delete cascade,
  pct integer not null,
  price_before numeric not null,
  price_after numeric not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  views integer,
  units integer,
  revenue numeric,
  demand_score numeric,
  created_at timestamptz not null default now()
);
create index if not exists weekly_deal_history_product_idx on public.weekly_deal_history (product_id, started_at desc);
create index if not exists weekly_deal_history_open_idx on public.weekly_deal_history (ended_at) where ended_at is null;
alter table public.weekly_deal_history enable row level security;
-- service role only (the edge function); no public policies on purpose.
