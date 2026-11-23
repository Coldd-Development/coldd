-- Product name aliases (2026-11-24): names a platform uses that differ from
-- ours. Each maps to the coldd.dev name, or the BuiltByBit name for a product
-- not on the site yet. The admin matches sales through it (Orders, Analytics).
create table if not exists public.product_name_aliases (
  alias text primary key,
  canonical text not null,
  created_at timestamptz not null default now()
);
alter table public.product_name_aliases enable row level security;
drop policy if exists product_name_aliases_admin_all on public.product_name_aliases;
create policy product_name_aliases_admin_all on public.product_name_aliases for all using (is_admin()) with check (is_admin());
insert into public.product_name_aliases (alias, canonical) values
  ('90+ MEGA Medieval Weapon Pack', 'PBR Medieval Weapon Pack'),
  ('[COMPLETE] Steal an Egg Game Template', 'Steal an Egg Template'),
  ('coldd Christmas Aura VFX Pack', 'Christmas Aura VFX Pack')
on conflict (alias) do update set canonical = excluded.canonical;
