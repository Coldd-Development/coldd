-- Social media content plan (admin Social media page): posts planned per platform, optionally
-- promoting a product, marked posted or skipped. Admins only.
create table if not exists public.social_posts (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('youtube', 'shorts', 'tiktok', 'x', 'instagram', 'discord')),
  planned_for date not null,
  title text not null check (char_length(title) between 1 and 200),
  product_id uuid references public.products(id) on delete set null,
  status text not null default 'planned' check (status in ('planned', 'posted', 'skipped')),
  posted_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists social_posts_planned_for_idx on public.social_posts (planned_for);
alter table public.social_posts enable row level security;
drop policy if exists social_posts_admin_all on public.social_posts;
create policy social_posts_admin_all on public.social_posts for all using (public.is_admin()) with check (public.is_admin());
