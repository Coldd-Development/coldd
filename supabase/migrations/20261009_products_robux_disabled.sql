-- Admin option to turn Robux pricing off for a product (and its resell licence).
-- Without it a missing robux_price just falls back to a flat USD->Robux conversion.
alter table public.products add column if not exists robux_disabled boolean not null default false;
comment on column public.products.robux_disabled is
  'When true the product cannot be bought or priced in Robux (storefront hides Robux prices; Robux checkout rejects it).';
