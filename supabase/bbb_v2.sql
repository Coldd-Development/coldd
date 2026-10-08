-- BuiltByBit stats from the v2 API (filled by the admin-bbb-v2-sync edge function).
--
--   bbb2_purchases   one row per purchase (account-wide). price_final is what the buyer paid
--                    (BuiltByBit's own revenue figure), fee is the platform fee.
--   bbb2_resources   one row per listing (price, description, images) for the listing checks
--   bbb2_funnel      page views / impressions / cart adds / wishlist adds / purchases / revenue
--                    per listing and period (resource_id 0 = every listing together)
--   bbb2_state       when each part last synced, and the last error
--
-- Admin-only (RLS on public.is_admin()); the sync function writes with the service role.
-- No buyer identity is stored.

create table if not exists public.bbb2_purchases (
  purchase_id   bigint primary key,
  resource_id   bigint,
  content_type  text,
  created_at    timestamptz not null,
  validated_at  timestamptz,
  price_final   numeric(12,2) not null default 0,
  price_list    numeric(12,2) not null default 0,
  fee           numeric(12,2) not null default 0,
  currency      text,
  gateway       text,
  bundle_id     bigint,
  sale_event_id bigint,
  synced_at     timestamptz not null default now()
);
create index if not exists bbb2_purchases_created_idx on public.bbb2_purchases (created_at);
create index if not exists bbb2_purchases_resource_idx on public.bbb2_purchases (resource_id);

create table if not exists public.bbb2_resources (
  resource_id      bigint primary key,
  title            text,
  url              text,
  summary          text,
  description      text,
  list_price       numeric(12,2),
  final_price      numeric(12,2),
  currency         text,
  cover_image_url  text,
  carousel_count   integer not null default 0,
  category         text,
  purchases        integer,
  downloads        integer,
  review_count     integer,
  review_average   numeric(4,2),
  latest_version   text,
  published_at     timestamptz,
  last_updated_at  timestamptz,
  synced_at        timestamptz not null default now()
);

create table if not exists public.bbb2_funnel (
  resource_id   bigint not null,
  period        text   not null,              -- '7' | '30' | '90' | 'all'
  page_views    integer not null default 0,
  impressions   integer not null default 0,
  cart_adds     integer not null default 0,
  wishlist_adds integer not null default 0,
  purchases     integer not null default 0,
  revenue       numeric(12,2) not null default 0,
  fetched_at    timestamptz not null default now(),
  primary key (resource_id, period)
);

create table if not exists public.bbb2_state (
  id                boolean primary key default true check (id),
  purchases_at      timestamptz,
  purchases_full_at timestamptz,
  resources_at      timestamptz,
  funnel_at         timestamptz,
  last_error        text,
  updated_at        timestamptz not null default now()
);
insert into public.bbb2_state (id) values (true) on conflict do nothing;

alter table public.bbb2_purchases enable row level security;
alter table public.bbb2_resources enable row level security;
alter table public.bbb2_funnel enable row level security;
alter table public.bbb2_state enable row level security;

do $$ begin create policy "bbb2_purchases_admin_select" on public.bbb2_purchases for select using (public.is_admin());
exception when duplicate_object then null; end $$;
do $$ begin create policy "bbb2_resources_admin_select" on public.bbb2_resources for select using (public.is_admin());
exception when duplicate_object then null; end $$;
do $$ begin create policy "bbb2_funnel_admin_select" on public.bbb2_funnel for select using (public.is_admin());
exception when duplicate_object then null; end $$;
do $$ begin create policy "bbb2_state_admin_select" on public.bbb2_state for select using (public.is_admin());
exception when duplicate_object then null; end $$;

revoke all on public.bbb2_purchases, public.bbb2_resources, public.bbb2_funnel, public.bbb2_state from public, anon;
grant select on public.bbb2_purchases, public.bbb2_resources, public.bbb2_funnel, public.bbb2_state to authenticated;
