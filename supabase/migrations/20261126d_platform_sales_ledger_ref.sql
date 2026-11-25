-- Parcel Robux orders from the Discord bot are linked to the group ledger sale they are.
alter table public.platform_sales add column if not exists ledger_ref text;
create unique index if not exists platform_sales_ledger_ref_key on public.platform_sales (ledger_ref) where ledger_ref is not null;
comment on column public.platform_sales.ledger_ref is 'Parcel Robux sales: robux_sales.id_hash of the group ledger sale this order is (price and net come from it). The admin drops linked ledger rows from its unnamed Parcel Robux figures.';
