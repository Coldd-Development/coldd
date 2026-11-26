-- Agency admin section (Commissions, Leads, Devs, Payouts, Services).
-- One JSON document per key; the admin pages read id = 'main'. Admin-only:
-- the content is the owner's internal commission plan (team roster, rates,
-- price floors), so it lives here behind RLS instead of in a public JS file.
-- The first document (sample commissions on the Notion "Commission team
-- expansion" roster and prices) was inserted straight into the database, not
-- in this migration.
create table if not exists public.agency_data (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.agency_data enable row level security;

do $$ begin
  create policy "agency_data_admin_all" on public.agency_data
    for all using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null;
end $$;

revoke all on public.agency_data from anon, authenticated;
grant select, insert, update, delete on public.agency_data to authenticated;
