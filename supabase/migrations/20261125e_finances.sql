-- Finances (2026-11-25): the owner's finance system, moved from the Google Sheet
-- "Finance Tracker" into /admin/finances/. Weekly net revenue (bank), the expense log,
-- TCG and other income (only for the tax maths), quarterly PAYG instalments and the
-- tax settings.
--
-- Locked to the owner by the database, not the page: every table is readable and
-- writable only when finance_allowed() is true for the signed-in account. Hiding or
-- deleting the lock screen in the browser shows an empty page; every request is refused.
-- An account passes when it is
--   * the owner's Discord account (auth.identities / profiles.discord_id, set by the
--     OAuth sign-in, never by the user), or
--   * the owner's Roblox account frchrono (profiles.roblox_id, set only by
--     roblox-oauth-callback), or
--   * frchrono@coldd.dev, but only in a session signed in with a code or link sent to
--     that inbox (email sign-ups here are not verified, so the address alone proves nothing).

create or replace function public.finance_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    exists (select 1 from auth.identities i
             where i.user_id = auth.uid() and i.provider = 'discord' and i.provider_id = '1327350011054526505')
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and (p.discord_id::text = '1327350011054526505' or p.roblox_id::text = '4893583890'))
    or (exists (select 1 from auth.users u
                 where u.id = auth.uid() and lower(u.email) = 'frchrono@coldd.dev' and u.email_confirmed_at is not null)
        and exists (select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
                     where a ->> 'method' in ('otp', 'magiclink')))
  )
$$;
revoke execute on function public.finance_allowed() from public, anon;
grant execute on function public.finance_allowed() to authenticated;

-- ---- Settings (one row): the sheet's Analytics inputs ----
create table if not exists public.finance_settings (
  id boolean primary key default true check (id),
  instalment_rate numeric not null default 0.0456,
  -- [[bracket start, rate], ...] ascending; 2026-27 resident rates.
  tax_brackets jsonb not null default '[[0,0],[18200,0.15],[45000,0.30],[135000,0.37],[190000,0.45]]',
  medicare_threshold numeric not null default 27222,
  medicare_rate numeric not null default 0.02,
  medicare_phase_in numeric not null default 0.10,
  lito_max numeric not null default 700,
  lito_full_to numeric not null default 37500,
  lito_mid_to numeric not null default 45000,
  lito_rate1 numeric not null default 0.05,
  lito_rate2 numeric not null default 0.015,
  gst_threshold numeric not null default 75000,
  updated_at timestamptz not null default now()
);
insert into public.finance_settings (id) values (true) on conflict (id) do nothing;

-- ---- One row per week (week ending on a Sunday, like the sheet) ----
-- revenue = coldd net revenue that reached the bank. TCG and other income are only
-- used to work out coldd's tax transfer (total income decides the tax).
create table if not exists public.finance_weeks (
  week_ending date primary key check (extract(isodow from week_ending) = 7),
  revenue numeric(12,2),
  tcg_revenue numeric(12,2),
  tcg_expenses numeric(12,2),
  other_income numeric(12,2),
  other_withheld numeric(12,2),
  note text,
  updated_at timestamptz not null default now()
);

-- ---- Expense log ----
create table if not exists public.finance_expense_categories (
  name text primary key check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);
create table if not exists public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  spent_on date not null,
  amount numeric(12,2) not null check (amount > 0),
  category text not null check (char_length(category) between 1 and 40),
  vendor text check (vendor is null or char_length(vendor) <= 80),
  note text check (note is null or char_length(note) <= 300),
  source text not null default 'manual' check (source in ('manual', 'sheet')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists finance_expenses_spent_on on public.finance_expenses (spent_on);

-- ---- Quarterly PAYG instalments actually paid ----
create table if not exists public.finance_instalments (
  fy text not null check (fy ~ '^\d{4}-\d{2}$'),
  quarter int not null check (quarter between 1 and 4),
  amount_paid numeric(12,2) check (amount_paid is null or amount_paid >= 0),
  paid_on date,
  note text check (note is null or char_length(note) <= 300),
  updated_at timestamptz not null default now(),
  primary key (fy, quarter)
);

-- ---- Lock ----
do $$
declare t text;
begin
  foreach t in array array['finance_settings', 'finance_weeks', 'finance_expense_categories', 'finance_expenses', 'finance_instalments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, public', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists finance_owner_only on public.%I', t);
    execute format('create policy finance_owner_only on public.%I for all to authenticated using ((select public.finance_allowed())) with check ((select public.finance_allowed()))', t);
  end loop;
end $$;
-- The settings row is never deleted or duplicated from the page.
revoke insert, delete on public.finance_settings from authenticated;

-- The owner's weeks, TCG figures and weekly expense totals were imported from the
-- Finance Tracker straight into the database on 2026-11-24. Financial data is never
-- kept in this repository.
insert into public.finance_expense_categories (name) values ('From the sheet') on conflict do nothing;
