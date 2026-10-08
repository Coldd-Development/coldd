-- Product license type + revenue share terms (admin product editor > Legal).
--
--   license_type  ownership | resell_plus | resell_rights | revenue_share   (null = not set yet)
--     ownership      we own the product outright
--     resell_plus    we sell it as normal AND can sell resell licenses to others ("resell+")
--     resell_rights  we can sell it, but cannot sell resell licenses to others
--     revenue_share  we sell it and owe the owner a percentage of sales
--
--   Revenue share only (cleared automatically when another type is chosen):
--     revenue_share_pct               percent of sales owed to the owner, e.g. 20
--     revenue_share_payment_platform  where we pay them, e.g. PayPal
--     revenue_share_payment_link      their payment link / address
--   The person being paid is the product's licenser contact (product_legal.contacts).
--
-- There is no automatic payout yet. The columns and the revenue_share_terms view exist so a
-- future tracker can read every revenue-share product without anyone selecting them by hand.

alter table public.product_legal
  add column if not exists license_type text,
  add column if not exists revenue_share_pct numeric(5,2),
  add column if not exists revenue_share_payment_platform text,
  add column if not exists revenue_share_payment_link text;

do $$ begin
  alter table public.product_legal add constraint product_legal_license_type_check
    check (license_type is null or license_type in ('ownership', 'resell_plus', 'resell_rights', 'revenue_share'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.product_legal add constraint product_legal_revenue_share_pct_check
    check (revenue_share_pct is null or (revenue_share_pct > 0 and revenue_share_pct <= 100));
exception when duplicate_object then null; end $$;

create index if not exists product_legal_revenue_share_idx
  on public.product_legal (product_id) where license_type = 'revenue_share';

-- Service-role only (product_legal has no client policies): every revenue-share product with its terms and contacts.
create or replace view public.revenue_share_terms with (security_invoker = true) as
  select p.id as product_id, p.slug, p.title,
         l.revenue_share_pct, l.revenue_share_payment_platform, l.revenue_share_payment_link, l.contacts
  from public.product_legal l
  join public.products p on p.id = l.product_id
  where l.license_type = 'revenue_share';
revoke all on public.revenue_share_terms from public, anon, authenticated;
grant select on public.revenue_share_terms to service_role;
