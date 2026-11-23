-- platform_sales: one row per sale on a marketplace that has no API sync of
-- its own (ClearlyDev, Parcel, Creator Store, Payhip). Filled by manual
-- imports now, and later by the Parcel Discord bot, the ClearlyDev email
-- monitor and the Creator Store userscript, all through the
-- platform-sales-ingest function. BuiltByBit stays in bbb2_purchases and
-- website orders stay in orders.
--
-- amount/currency is what the buyer paid in the platform's own unit (ROBUX
-- for Robux sales). amount_usd is that same figure in USD, fixed when the row
-- is written (Robux at the DevEx rate), so the admin can total every platform
-- without looking up historic exchange rates.
--
-- admin_todos: the free-text tasks typed into "Today's work" on the admin
-- home page. Shared between every admin.

create table if not exists public.platform_sales (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('clearlydev', 'parcel', 'creatorstore', 'payhip')),
  external_id text check (char_length(external_id) <= 200),
  sold_at timestamptz not null,
  product_id uuid references public.products(id) on delete set null,
  product_name text check (char_length(product_name) <= 300),
  currency text not null default 'USD' check (currency = 'ROBUX' or currency ~ '^[A-Z]{3}$'),
  amount numeric(14, 4) not null check (amount >= 0),
  amount_usd numeric(14, 4) not null check (amount_usd >= 0),
  net_amount numeric(14, 4) check (net_amount >= 0),
  net_usd numeric(14, 4) check (net_usd >= 0),
  quantity integer not null default 1 check (quantity between 1 and 10000),
  buyer_name text check (char_length(buyer_name) <= 200),
  buyer_ref text check (char_length(buyer_ref) <= 200),
  status text not null default 'paid' check (status in ('paid', 'pending', 'refunded')),
  source text not null default 'manual' check (source in ('manual', 'discord', 'email', 'userscript', 'api')),
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Re-sending the same sale (the userscript re-syncs every few minutes)
  -- updates the row instead of duplicating it. NULL external ids never clash.
  constraint platform_sales_platform_external_key unique (platform, external_id)
);

create index if not exists platform_sales_sold_at_idx on public.platform_sales (sold_at desc);
create index if not exists platform_sales_platform_sold_idx on public.platform_sales (platform, sold_at desc);
alter table public.platform_sales enable row level security;

create table if not exists public.admin_todos (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 300),
  done boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  created_by_name text,
  done_at timestamptz,
  done_by_name text
);

create index if not exists admin_todos_open_idx on public.admin_todos (done, created_at desc);
alter table public.admin_todos enable row level security;

do $$ begin
  create policy "platform_sales_admin_all" on public.platform_sales
    for all using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "admin_todos_admin_all" on public.admin_todos
    for all using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null;
end $$;

revoke all on public.platform_sales from anon, authenticated;
revoke all on public.admin_todos from anon, authenticated;
grant select, insert, update, delete on public.platform_sales to authenticated;
grant select, insert, update, delete on public.admin_todos to authenticated;
