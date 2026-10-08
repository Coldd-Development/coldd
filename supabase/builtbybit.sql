-- BuiltByBit marketplace stats (filled by the admin-builtbybit-sync edge function).
--
--   bbb_purchases           one row per BuiltByBit purchase (the revenue / order source)
--   bbb_reviews             reviews on our listings (reply from the admin panel)
--   bbb_resource_snapshots  one row per listing per day (downloads, rating, version)
--
-- Admin-only, same pattern as marketplace_listings: RLS gated on public.is_admin().
-- The sync function writes with the service role, so there are no write policies.

create table if not exists public.bbb_purchases (
  purchase_id    text primary key,
  resource_id    text not null,
  resource_title text,
  purchaser_id   text,
  price          numeric(12,2) not null default 0,
  currency       text,
  status         text,
  renewal        boolean not null default false,
  purchased_at   timestamptz not null,
  synced_at      timestamptz not null default now()
);
create index if not exists bbb_purchases_purchased_at_idx on public.bbb_purchases (purchased_at);
create index if not exists bbb_purchases_resource_idx on public.bbb_purchases (resource_id);

create table if not exists public.bbb_reviews (
  review_id      text primary key,
  resource_id    text not null,
  resource_title text,
  reviewer_id    text,
  rating         numeric(3,1),
  message        text,
  response       text,
  reviewed_at    timestamptz,
  synced_at      timestamptz not null default now()
);
create index if not exists bbb_reviews_reviewed_at_idx on public.bbb_reviews (reviewed_at desc);

create table if not exists public.bbb_resource_snapshots (
  resource_id    text not null,
  snapshot_date  date not null,
  title          text,
  price          numeric(12,2),
  currency       text,
  downloads      integer,
  purchases      integer,
  reviews        integer,
  rating         numeric(4,2),
  latest_version text,
  synced_at      timestamptz not null default now(),
  primary key (resource_id, snapshot_date)
);

alter table public.bbb_purchases enable row level security;
alter table public.bbb_reviews enable row level security;
alter table public.bbb_resource_snapshots enable row level security;

do $$ begin
  create policy "bbb_purchases_admin_select" on public.bbb_purchases for select using (public.is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "bbb_reviews_admin_select" on public.bbb_reviews for select using (public.is_admin());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "bbb_resource_snapshots_admin_select" on public.bbb_resource_snapshots for select using (public.is_admin());
exception when duplicate_object then null; end $$;

-- Never readable or writable by the public. (Supabase hands anon/authenticated
-- table privileges by default; RLS already blocks them, this is belt and braces.)
revoke all on public.bbb_purchases, public.bbb_reviews, public.bbb_resource_snapshots from public, anon;
grant select on public.bbb_purchases, public.bbb_reviews, public.bbb_resource_snapshots to authenticated;

-- ---------------------------------------------------------------------------
-- Part 2: category, resumable sync state, dismissed issues, counts RPC.
-- ---------------------------------------------------------------------------

alter table public.bbb_resource_snapshots add column if not exists category text;

-- Per listing: when its purchases/reviews were last read. Lets a sync that has
-- hundreds of listings resume where it left off instead of starting over.
create table if not exists public.bbb_resource_state (
  resource_id text primary key,
  detail_at   timestamptz,
  note        text
);
alter table public.bbb_resource_state enable row level security;
do $$ begin
  create policy "bbb_resource_state_admin_select" on public.bbb_resource_state for select using (public.is_admin());
exception when duplicate_object then null; end $$;
revoke all on public.bbb_resource_state from public, anon;
grant select on public.bbb_resource_state to authenticated;

-- "Potential issues" the admin has dismissed (the delete icon). Key is
-- "<type>:<product or listing id>".
create table if not exists public.bbb_issue_dismissals (
  issue_key    text primary key,
  dismissed_at timestamptz not null default now()
);
alter table public.bbb_issue_dismissals enable row level security;
do $$ begin
  create policy "bbb_issue_dismissals_admin_all" on public.bbb_issue_dismissals
    for all using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;
revoke all on public.bbb_issue_dismissals from public, anon;
grant select, insert, update, delete on public.bbb_issue_dismissals to authenticated;

-- Stored purchase / review counts per listing, for the sync's work queue
-- (PostgREST caps plain selects at 1000 rows, so aggregate in the database).
create or replace function public.bbb_detail_counts()
returns table (resource_id text, purchases_n bigint, pending_n bigint, reviews_n bigint)
language sql stable security definer set search_path = public
as $$
  select coalesce(p.resource_id, r.resource_id),
         coalesce(p.n, 0), coalesce(p.pending, 0), coalesce(r.n, 0)
  from (select resource_id, count(*) n, count(*) filter (where status = 'pending') pending
        from public.bbb_purchases group by 1) p
  full join (select resource_id, count(*) n from public.bbb_reviews group by 1) r
    on r.resource_id = p.resource_id;
$$;
revoke all on function public.bbb_detail_counts() from public, anon, authenticated;

grant execute on function public.bbb_detail_counts() to service_role;

-- Part 3: last COMPLETE read of every purchase (a quick read of the newest pages does not count).
alter table public.bbb_resource_state add column if not exists full_at timestamptz;

-- Part 4: when BuiltByBit validated the purchase (null while pending). BuiltByBit credits revenue on this date.
alter table public.bbb_purchases add column if not exists validation_date timestamptz;
