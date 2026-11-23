-- Aliases with a price (2026-11-24): when two products sell under one name, an
-- alias can apply only to sales at about a given US$ price (within 10%, at least
-- US$0.50). Creator Store's "Steal an Egg Template Map" at US$9.99 is BuiltByBit's
-- "Steal an Egg Template Map 2", not the US$5.99 "Steal an Egg Map Template".
alter table public.product_name_aliases add column if not exists price_usd numeric;
alter table public.product_name_aliases drop constraint if exists product_name_aliases_pkey;
alter table public.product_name_aliases add column if not exists id bigserial primary key;
create unique index if not exists product_name_aliases_alias_price on public.product_name_aliases (lower(alias), coalesce(price_usd, -1));
comment on column public.product_name_aliases.price_usd is 'Optional: the alias only applies to sales at about this US$ price (two products sold under one name).';
insert into public.product_name_aliases (alias, canonical, price_usd) values ('Steal an Egg Template Map', 'Steal an Egg Template Map 2', 9.99);
