-- Giveaway / prize claim portal (coldd.dev/claim) + admin Giveaways panel.
--
-- A winner signs in, answers where they won and what they won, gives the
-- payout detail for that prize (gamepass link / PayPal email / a product
-- from the claimable list / a description), uploads a screenshot as proof
-- and submits. The row lands as 'pending' ("Awaiting confirmation") in the
-- admin Giveaways panel, where staff mark it 'fulfilled' or 'declined'
-- (with a reason). Every stage notifies the winner through the nav bell.
--
-- Writes go through the claim-prize / admin-prize-claims edge functions
-- (service role) only. Winners can read their own rows so /claim can show
-- the status of past claims.

create table if not exists public.prize_claims (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'declined')),

  source text not null check (source in ('discord_giveaway', 'discord_event', 'builtbybit', 'other')),
  source_other text check (char_length(source_other) <= 500),
  prize_type text not null check (prize_type in ('robux', 'product', 'currency', 'other')),
  prize_other text check (char_length(prize_other) <= 500),

  -- Payout detail, one of these per prize_type.
  gamepass_url text check (char_length(gamepass_url) <= 300),
  gamepass_id bigint,
  gamepass_info jsonb,                       -- best-effort {name, price, creatorName, creatorType} at submit
  paypal_email text check (char_length(paypal_email) <= 254),
  product_id uuid references public.products(id) on delete set null,
  product_slug text,
  product_title text,

  proof_path text not null,                  -- object in the private prize-claims bucket

  -- Who they proved they are, captured server-side at submit.
  verified_discord_id text,
  verified_discord_name text,
  verified_bbb_id text,
  verified_bbb_name text,
  account_email text,
  account_name text,

  decline_reason text check (char_length(decline_reason) <= 1000),
  order_id uuid references public.orders(id) on delete set null,   -- product prizes granted on fulfil
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_by_name text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prize_claims_status_created_idx on public.prize_claims (status, created_at desc);
create index if not exists prize_claims_user_idx on public.prize_claims (user_id, created_at desc);

alter table public.prize_claims enable row level security;

drop policy if exists prize_claims_select_own on public.prize_claims;
create policy prize_claims_select_own on public.prize_claims
  for select to authenticated using (user_id = auth.uid());
-- No insert/update/delete policies: the edge functions (service role) own writes.

-- Products a winner may pick as a free prize: live, and not marked
-- "Cannot be given away for free" (product_legal.can_be_free). A product
-- with no legal row counts as not-freeable, matching _shared/coupon.ts.
create or replace function public.claimable_products()
returns table (id uuid, slug text, title text, image text, platform text, cat text)
language sql stable security definer set search_path = public as $$
  select p.id, p.slug, p.title, p.image, p.platform, p.cat
  from public.products p
  join public.product_legal l on l.product_id = p.id
  where p.is_active and l.can_be_free
  order by p.title;
$$;
revoke all on function public.claimable_products() from public;
grant execute on function public.claimable_products() to anon, authenticated;

-- Screenshot proofs. Private: winners upload through a signed URL minted by
-- claim-prize, staff view through short-lived signed URLs from
-- admin-prize-claims. Nobody lists or reads the bucket directly.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('prize-claims', 'prize-claims', false, 8388608, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
