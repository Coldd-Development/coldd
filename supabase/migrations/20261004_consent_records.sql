-- Server-side proof of consent (GDPR Art. 7(1): the controller must be able to
-- demonstrate consent). Two parts:
--
-- 1. consent_log - one row per cookie-banner decision. Previously the choice
--    lived only in the visitor's own localStorage, which proves nothing to a
--    regulator. Insert-only for anon/authenticated; nobody but service role
--    and admins can read it. visitor_id is a random per-browser id, never
--    derived from anything identifying; user_id is filled only when the
--    visitor was signed in at the time.
create table if not exists public.consent_log (
  id bigint generated always as identity primary key,
  visitor_id text not null check (char_length(visitor_id) between 8 and 64),
  user_id uuid references auth.users(id) on delete set null,
  analytics boolean not null,
  banner_version int not null,
  page text check (page is null or char_length(page) <= 200),
  created_at timestamptz not null default now()
);

alter table public.consent_log enable row level security;

drop policy if exists consent_log_insert on public.consent_log;
create policy consent_log_insert on public.consent_log
  for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

drop policy if exists consent_log_admin_read on public.consent_log;
create policy consent_log_admin_read on public.consent_log
  for select using (public.is_admin());

-- 2. marketing_optins already records who/when/where; add the exact wording the
--    person agreed to, so a later wording change can't muddy what they consented to.
alter table public.marketing_optins add column if not exists consent_text text;
