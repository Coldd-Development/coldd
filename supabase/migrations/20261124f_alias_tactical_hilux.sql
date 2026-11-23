-- Name aliases (2026-11-24): Creator Store's "SCRIPTED Tactical Truck" and
-- BuiltByBit's "Tactical SUV" are coldd.dev's "Tactical Toyota Hilux".
insert into public.product_name_aliases (alias, canonical) values
  ('SCRIPTED Tactical Truck', 'Tactical Toyota Hilux'),
  ('Tactical SUV', 'Tactical Toyota Hilux')
on conflict (lower(alias), coalesce(price_usd, -1)) do update set canonical = excluded.canonical;
