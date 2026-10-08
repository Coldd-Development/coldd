-- Product license types + revenue share terms (admin product editor > Legal).
--
--   license_types  text[]  any combination of:
--     ownership      we own the product outright
--     resell_plus    we sell it as normal AND can sell resell licenses to others ("resell+")
--     resell_rights  we can sell it, but cannot sell resell licenses to others
--     revenue_share  we sell it and owe the owner a percentage of sales
--   An empty array means not set yet.
--
--   Revenue share only (cleared automatically when revenue_share is not selected):
--     revenue_share_pct               percent of sales owed to the owner, e.g. 20
--     revenue_share_payment_platform  where we pay them, e.g. PayPal
--     revenue_share_payment_link      their payment link / address
--   The person being paid is the product's licenser contact (product_legal.contacts).
--
-- There is no automatic payout yet. The columns and the revenue_share_terms view exist so a
-- future tracker can read every revenue-share product without anyone selecting them by hand.
--
-- THE BAR: resell licenses (products.resell_available) cannot be on for a product whose
-- license_types include resell_rights unless they also include resell_plus. Enforced here in the
-- database (so it holds for every code path) and mirrored in admin-upsert-product and the editor.

alter table public.product_legal
  add column if not exists license_types text[] not null default '{}',
  add column if not exists revenue_share_pct numeric(5,2),
  add column if not exists revenue_share_payment_platform text,
  add column if not exists revenue_share_payment_link text;

-- (an earlier single-value version of this column)
drop view if exists public.revenue_share_terms;
drop index if exists public.product_legal_revenue_share_idx;
alter table public.product_legal drop constraint if exists product_legal_license_type_check;
alter table public.product_legal drop column if exists license_type;

do $$ begin
  alter table public.product_legal add constraint product_legal_license_types_check
    check (license_types <@ array['ownership', 'resell_plus', 'resell_rights', 'revenue_share']::text[]);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.product_legal add constraint product_legal_revenue_share_pct_check
    check (revenue_share_pct is null or (revenue_share_pct > 0 and revenue_share_pct <= 100));
exception when duplicate_object then null; end $$;

create index if not exists product_legal_revenue_share_idx
  on public.product_legal (product_id) where 'revenue_share' = any(license_types);

-- Service-role only (product_legal has no client policies): every revenue-share product with its terms and contacts.
create or replace view public.revenue_share_terms with (security_invoker = true) as
  select p.id as product_id, p.slug, p.title, l.license_types,
         l.revenue_share_pct, l.revenue_share_payment_platform, l.revenue_share_payment_link, l.contacts
  from public.product_legal l
  join public.products p on p.id = l.product_id
  where 'revenue_share' = any(l.license_types);
revoke all on public.revenue_share_terms from public, anon, authenticated;
grant select on public.revenue_share_terms to service_role;

-- ---- the bar on resell licenses ---------------------------------------------------------
create or replace function public.license_blocks_resell(t text[]) returns boolean
language sql immutable as $$
  select coalesce(t, '{}') @> array['resell_rights']::text[] and not (coalesce(t, '{}') @> array['resell_plus']::text[]);
$$;

-- Turning resell licenses on for a blocked product is refused.
create or replace function public.products_resell_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.resell_available and exists (
    select 1 from public.product_legal l where l.product_id = new.id and public.license_blocks_resell(l.license_types)
  ) then
    raise exception 'Resell licenses cannot be sold on a Resell Rights product (add Resell+ to allow them).' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists products_resell_guard on public.products;
create trigger products_resell_guard before insert or update of resell_available on public.products
  for each row execute function public.products_resell_guard();

-- Giving a product a blocking license type switches resell licenses off for it.
create or replace function public.product_legal_resell_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.license_blocks_resell(new.license_types) then
    update public.products set resell_available = false where id = new.product_id and resell_available;
  end if;
  return new;
end $$;
drop trigger if exists product_legal_resell_sync on public.product_legal;
create trigger product_legal_resell_sync after insert or update of license_types on public.product_legal
  for each row execute function public.product_legal_resell_sync();
