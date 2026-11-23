-- More product name aliases (2026-11-24): Creator Store's "500+ Combat VFX Pack"
-- is BuiltByBit's "500+ Combat VFX Asset Pack" (not coldd.dev's "Combat VFX
-- Pack"), plus three names the stricter matcher no longer guesses.
insert into public.product_name_aliases (alias, canonical) values
  ('500+ Combat VFX Pack', '500+ Combat VFX Asset Pack'),
  ('Kings Landing Asset Pack', 'Game of Thrones Kings Landing Asset Pack'),
  ('MILW EF1 Locomotive Train', 'MILW EF1 Electric Locomotive'),
  ('Aura VFX Pack #2', 'Aura VFX Asset Pack 2')
on conflict (alias) do update set canonical = excluded.canonical;
