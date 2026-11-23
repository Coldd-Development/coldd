-- platform_sync_state: one row per background marketplace sync (first:
-- creatorstore, run by the creator-store-sync function every 5 minutes).
-- The admin home reads it to flag a dead cookie in Today's work.
create table if not exists public.platform_sync_state (
  platform text primary key check (platform in ('clearlydev', 'parcel', 'creatorstore', 'payhip')),
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  cookie_ok boolean,
  newest_sale_at timestamptz,
  last_written integer,
  updated_at timestamptz not null default now()
);
alter table public.platform_sync_state enable row level security;

do $$ begin
  create policy "platform_sync_state_admin_read" on public.platform_sync_state
    for select using (public.is_admin());
exception when duplicate_object then null;
end $$;

revoke all on public.platform_sync_state from anon, authenticated;
grant select on public.platform_sync_state to authenticated;
