-- Run this once in Supabase Dashboard -> SQL Editor (after products.sql)
--
-- Internal licensing/legal data for each product: proof of license, the
-- licenser's contact details, what coldd paid for the licence and when,
-- sale-price floors, and internal usage restrictions. NONE of this is
-- customer-facing (unlike public.products), so this table gets RLS enabled
-- with NO select/insert/update/delete policy at all - it's reachable only
-- from Edge Functions running with the service-role key. A client using the
-- anon or an authenticated user's key can never read or write a single row
-- here, no matter who they are.

create table if not exists public.product_legal (
  product_id uuid primary key references public.products(id) on delete cascade,
  tos text not null default '',
  proof_files jsonb not null default '[]'::jsonb,
  dev_proof_files jsonb not null default '[]'::jsonb,
  contacts jsonb not null default '[]'::jsonb,
  license_cost numeric(10,2) not null default 0,
  license_cost_currency text not null default 'usd' check (license_cost_currency in ('usd', 'robux')),
  license_purchased_at date,
  min_regular_usd numeric(10,2) not null default 0,
  min_regular_robux numeric(10,2) not null default 0,
  min_sale_usd numeric(10,2) not null default 0,
  min_sale_robux numeric(10,2) not null default 0,
  -- Cap on the discount PERCENTAGE any sale/coupon/deal may take off the
  -- list price (0 = no cap). Enforced alongside the min_sale_* floors and
  -- disallow_sales - whichever limit bites first wins.
  max_discount_pct numeric(5,2) not null default 0 check (max_discount_pct >= 0 and max_discount_pct <= 100),
  can_be_free boolean not null default false,
  disallow_sales boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.product_legal enable row level security;
-- Intentionally no policies: RLS enabled with zero policies means every
-- client request is denied by default. Only the service role bypasses RLS.

-- contacts jsonb shape (mirrors admin.js's editContacts):
--   [{ label, value }]
-- proof_files / dev_proof_files jsonb shape (mirrors admin.js's
-- editProofFiles/editDevProofFiles): [{ name, url }], where url is a real
-- Storage URL once uploads go through admin-get-upload-url (a client-side
-- blob: URL in the interim, which won't survive a page reload).
