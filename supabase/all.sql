-- Full schema for a FRESH coldd Supabase project, in dependency order.
-- Run this once in Supabase Dashboard -> SQL Editor when setting up a
-- brand new project from scratch.
--
-- IMPORTANT: this is NOT what you run to fix an already-partially-set-up
-- project (like this one was) - re-running the CREATE POLICY statements
-- below against a project that already has them will error on duplicates.
-- For that situation, run catchup_missing_schema.sql and
-- admin_read_policies.sql instead, which only add what's missing.

-- ===== profiles.sql =====
-- Run this once in Supabase Dashboard -> SQL Editor
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  discord_id text,
  username text,
  email text,
  avatar_url text,
  guilds jsonb,
  member_info jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Each user can only read/write their own profile row
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_upsert_own" on public.profiles
  for insert with check (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- ===== email_otps.sql =====
-- Run this once in Supabase Dashboard -> SQL Editor
-- (in addition to the earlier profiles.sql)

alter table public.profiles add column if not exists email_verified boolean not null default false;

create table if not exists public.email_otps (
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

-- Locked down: only the service role (used inside the Edge Function) touches
-- this table. No policies are added for anon/authenticated on purpose.
alter table public.email_otps enable row level security;

-- ===== email_exists.sql =====
-- Run this in Supabase SQL Editor
create or replace function public.email_exists(check_email text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(select 1 from auth.users where email = check_email);
$$;

grant execute on function public.email_exists(text) to anon, authenticated;

-- ===== products.sql =====
-- Run this once in Supabase Dashboard -> SQL Editor

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  price_usd numeric(10,2) not null,
  resell_available boolean not null default false,
  was_price numeric(10,2),
  image text,
  description text,
  cat text,
  subcat text,
  platform text not null check (platform in ('Roblox', 'Minecraft')),
  page text not null default '/shop',
  reviews_count int not null default 0,
  rating numeric(2,1) not null default 0,
  storage_path text not null default '_shared/placeholder.zip',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products enable row level security;

-- Public catalog is read-only to everyone. No write policy is added on
-- purpose: writes go through the service role only (manual SQL for now,
-- admin Edge Functions in a later phase).
create policy "products_select_active" on public.products
  for select using (is_active = true);

-- ===== products_admin_fields.sql =====
-- Run this once in Supabase Dashboard -> SQL Editor (after products.sql)
--
-- Adds the fields introduced by the expanded admin product-edit form:
-- media (gallery/video), extra pricing, and technical specs. All of these
-- are safe to expose through the existing "products_select_active" public
-- read policy - they're meant to be shown on the storefront.
--
-- Licensing/legal data (proof files, licenser contacts, cost paid, internal
-- restriction notes) is NOT stored here - see product_legal.sql, which is
-- a separate table with no public read policy at all.

alter table public.products add column if not exists gallery jsonb not null default '[]'::jsonb;
alter table public.products add column if not exists video text;
alter table public.products add column if not exists long_description text;
alter table public.products add column if not exists resell_price_usd numeric(10,2);
alter table public.products add column if not exists robux_price numeric(10,2);
alter table public.products add column if not exists tech jsonb not null default '{}'::jsonb;
alter table public.products add column if not exists versions jsonb not null default '[]'::jsonb;

-- tech jsonb shape (mirrors admin.js's defaultTech()):
--   { format, size, fileName, parts, meshParts, unions, scripts }
--
-- versions jsonb shape (mirrors the Push Update panel):
--   [{ version, changelog, date, ... }]

-- ===== product_legal.sql =====
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

-- ===== orders.sql =====
-- Run this once in Supabase Dashboard -> SQL Editor (after products.sql)

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'failed', 'refunded', 'canceled')),
  currency text not null default 'usd',
  subtotal_usd numeric(10,2) not null,
  discount_usd numeric(10,2) not null default 0,
  total_usd numeric(10,2) not null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.orders enable row level security;

-- Buyers can read their own orders. No insert/update/delete policy is added:
-- only the service role (used inside the Edge Functions) ever writes here.
create policy "orders_select_own" on public.orders
  for select using (auth.uid() = user_id);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  product_slug text not null,
  title text not null,
  licence text not null default 'standard' check (licence in ('standard', 'resell')),
  unit_price_usd numeric(10,2) not null,
  qty int not null default 1,
  created_at timestamptz not null default now()
);

alter table public.order_items enable row level security;

-- Same lockdown as orders: readable only by the owning buyer, via the
-- parent order's user_id. No client write policy.
create policy "order_items_select_own" on public.order_items
  for select using (
    exists (
      select 1 from public.orders o
      where o.id = order_items.order_id and o.user_id = auth.uid()
    )
  );

create index if not exists order_items_order_id_idx on public.order_items(order_id);
create index if not exists order_items_product_slug_idx on public.order_items(product_slug);

-- ===== profiles_admin.sql =====
-- Run this once in Supabase Dashboard -> SQL Editor
-- (in addition to the earlier profiles.sql / email_otps.sql)

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- No RLS change needed: is_admin is only ever read by the service role inside
-- Edge Functions (a later phase), never exposed as a client-writable field.

-- ===== admin_read_policies.sql =====
-- Run this ONCE in the Supabase Dashboard -> SQL Editor, after
-- catchup_missing_schema.sql. Safe to re-run (guards duplicate policy
-- creation).
--
-- Lets signed-in admins (profiles.is_admin = true) read every product
-- (including hidden/inactive ones) and their product_legal rows, so the
-- admin panel can actually list and edit everything, not just what's
-- publicly visible. Writes still only ever happen through the
-- admin-upsert-product / admin-delete-product Edge Functions (service
-- role) - this only adds read access for the admin panel's own UI.

do $$ begin
  create policy "products_select_admin" on public.products
    for select using (
      exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true)
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "product_legal_select_admin" on public.product_legal
    for select using (
      exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.is_admin = true)
    );
exception when duplicate_object then null;
end $$;

-- ===== products_seed.sql =====
-- Generated by scripts/generate_products_sql.py -- do not hand-edit.
-- Run this once in Supabase Dashboard -> SQL Editor, after products.sql.

insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('all-brawl-full-game', 'ALL BRAWL Full Game', 89.0, true, null, 'premade.jpg', 'Complete fighting game, fully scripted and ready to launch.', 'Finished Games & Templates', 'finished-games', 'Roblox', '/shop', 214, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('frostline-survival-kit', 'Frostline Survival Kit', 129.0, true, 189.0, 'new-release.jpg', 'Full survival game with crafting, biomes, and progression.', 'Finished Games & Templates', 'finished-games', 'Roblox', '/shop', 96, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('cyberpunk-district', 'Cyberpunk District', 45.0, true, 69.0, 'new-release.jpg', 'Neon-lit city map with detailed streets and interiors.', 'Maps', 'cities-towns', 'Roblox', '/shop', 142, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('containment-site', 'Containment Site', 38.0, true, null, 'builds.jpg', 'Secure facility map built for roleplay and SCP games.', 'Maps', 'scpf', 'Roblox', '/shop', 58, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('scp-courtroom', 'SCP Courtroom', 25.0, true, null, 'builds.jpg', 'Detailed courtroom interior, drop-in ready.', 'Buildings', 'scpf', 'Roblox', '/shop', 33, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('industrial-refinery', 'Industrial Refinery', 32.0, true, null, 'products.jpg', 'Gritty industrial complex with pipes, tanks, and catwalks.', 'Buildings', 'military', 'Roblox', '/shop', 21, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('ancient-temple', 'Ancient Temple', 28.0, false, null, 'cta-bg.jpg', 'Ruined stone temple with traps and hidden chambers.', 'Buildings', 'medieval', 'Roblox', '/shop', 47, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('tic-tac-toe-system', 'Tic Tac Toe System', 12.0, false, null, 'scripts.jpg', 'Plug-and-play Tic Tac Toe minigame with clean UI.', 'Scripts & UI', 'scripted-systems', 'Roblox', '/shop', 180, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('combat-hud-kit', 'Combat HUD Kit', 18.0, false, 27.0, 'banner.jpg', 'Health, ammo, and hitmarker HUD for combat games.', 'Scripts & UI', 'combat', 'Roblox', '/shop', 260, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('inventory-ui-pack', 'Inventory UI Pack', 16.0, false, null, 'scripts.jpg', 'Slot-based inventory system with drag and drop.', 'Scripts & UI', 'ui-packs', 'Roblox', '/shop', 77, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('vfx-starter-pack', 'VFX Starter Pack', 22.0, false, null, 'banner.jpg', '20 ready-to-use particle and explosion effects.', 'Animations & VFX', 'vfx', 'Roblox', '/shop', 128, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('emote-animation-set', 'Emote Animation Set', 19.0, false, null, 'team-bg.jpg', 'Smooth character emotes and idle animations.', 'Animations & VFX', 'animations', 'Roblox', '/shop', 64, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('tactical-uniforms', 'Tactical Uniforms', 15.0, false, null, 'team-bg.jpg', 'Military-grade uniform set with gear attachments.', 'Uniforms & Gear', '2d-uniforms', 'Roblox', '/shop', 39, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('naval-boat-pack', 'Naval Boat Pack', 35.0, false, null, 'products.jpg', 'Drivable boats with physics and detailed models.', 'Boats', 'military', 'Roblox', '/shop', 0, 0.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('weapon-pack-vol-1', 'Weapon Pack Vol.1', 24.0, false, null, 'builds.jpg', 'Modeled weapon set with viewmodels and sounds.', 'Weapons', 'firearms', 'Roblox', '/shop', 112, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('drift-vehicle-pack', 'Drift Vehicle Pack', 42.0, false, null, 'new-release.jpg', 'Tunable drift cars with working suspension.', 'Vehicles', 'civilian', 'Roblox', '/shop', 88, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('thumbnail-bundle', 'Thumbnail Bundle', 25.0, false, null, 'frostline.jpg', 'High-quality thumbnails and icons for your store.', 'Graphics', 'logos', 'Roblox', '/shop', 150, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('logo-icon-kit', 'Logo & Icon Kit', 20.0, false, null, 'banner.jpg', 'Clean logo and icon templates, fully editable.', 'Graphics', 'logos', 'Roblox', '/shop', 0, 0.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('asset-mega-bundle', 'Asset Mega Bundle', 150.0, true, 199.0, 'premade.jpg', 'Our biggest pack, hundreds of assets in one bundle.', 'Assets', 'asset-packs', 'Roblox', '/shop', 420, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('skyblock-network-hub', 'Skyblock Network Hub', 45.0, true, null, 'minecraft.jpg', 'Polished skyblock hub with portals and shops.', 'Hubs', null, 'Minecraft', '/minecraft', 134, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('fantasy-spawn', 'Fantasy Spawn', 38.0, true, null, 'new-release.jpg', 'Detailed fantasy spawn with custom terrain.', 'Hubs', null, 'Minecraft', '/minecraft', 52, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('minigames-lobby', 'Minigames Lobby', 30.0, false, null, 'builds.jpg', 'Bright minigames lobby with NPC selectors.', 'Lobbies', null, 'Minecraft', '/minecraft', 71, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('practice-pvp-lobby', 'Practice PvP Lobby', 28.0, false, null, 'products.jpg', 'Clean PvP practice lobby with arenas.', 'Lobbies', null, 'Minecraft', '/minecraft', 96, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('survival-world', 'Survival World', 42.0, false, null, 'frostline.jpg', 'Hand-built survival world with custom biomes.', 'Maps', null, 'Minecraft', '/minecraft', 40, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('adventure-map', 'Adventure Map', 36.0, false, null, 'premade.jpg', 'Story-driven adventure map with quests.', 'Maps', null, 'Minecraft', '/minecraft', 0, 0.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('medieval-castle', 'Medieval Castle', 25.0, true, null, 'builds.jpg', 'Fully detailed medieval castle build.', 'Builds', null, 'Minecraft', '/minecraft', 118, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('modern-city-pack', 'Modern City Pack', 60.0, true, 80.0, 'products.jpg', 'Modern city build with skyscrapers and roads.', 'Builds', null, 'Minecraft', '/minecraft', 63, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('custom-enchants', 'Custom Enchants', 20.0, false, null, 'scripts.jpg', 'Configurable custom enchantments plugin.', 'Plugins', null, 'Minecraft', '/minecraft', 205, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('cosmetics-plugin', 'Cosmetics Plugin', 18.0, false, null, 'banner.jpg', 'Particles, pets, and cosmetics for your server.', 'Plugins', null, 'Minecraft', '/minecraft', 58, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('skyblock-full-setup', 'Skyblock Full Setup', 120.0, true, null, 'premade.jpg', 'Complete skyblock server, configured and ready.', 'Full Setups', null, 'Minecraft', '/minecraft', 76, 5.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('prison-full-setup', 'Prison Full Setup', 99.0, false, null, 'cta-bg.jpg', 'Full prison server with ranks, cells, and an economy loop.', 'Full Setups', null, 'Minecraft', '/minecraft', 25, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('ranger-skin-pack', 'Ranger Skin Pack', 12.0, false, null, 'team-bg.jpg', '12 ranger-themed player skins with matching capes.', 'Skins', null, 'Minecraft', '/minecraft', 25, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('custom-mob-models', 'Custom Mob Models', 35.0, false, null, 'new-release.jpg', 'Custom-modeled mobs and bosses, rigged and ready to drop in.', 'Models', null, 'Minecraft', '/minecraft', 25, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('menu-gui-pack', 'Menu GUI Pack', 15.0, false, null, 'scripts.jpg', 'Clean inventory and shop menus for survival and factions servers.', 'Guis', null, 'Minecraft', '/minecraft', 25, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('spawn-schematic-bundle', 'Spawn Schematic Bundle', 22.0, false, null, 'frostline.jpg', 'Ready-to-paste spawn builds for survival, skyblock, and prison.', 'Schematics', null, 'Minecraft', '/minecraft', 25, 4.0) on conflict (slug) do nothing;
insert into public.products (slug, title, price_usd, resell_available, was_price, image, description, cat, subcat, platform, page, reviews_count, rating) values ('fantasy-texture-pack', 'Fantasy Texture Pack', 26.0, false, null, 'banner.jpg', '32x fantasy resource pack covering blocks, items, and UI.', 'Textures', null, 'Minecraft', '/minecraft', 25, 4.0) on conflict (slug) do nothing;

-- ===== profiles_admin_seed.sql =====
-- Run this once in Supabase Dashboard -> SQL Editor (after profiles_admin.sql)
--
-- Grants is_admin to the same two Discord IDs already whitelisted
-- client-side in supabase-init.js's ADMIN_WHITELIST. Only takes effect for
-- accounts that have signed in at least once (a profiles row only exists
-- after first login) - if either admin hasn't logged in yet, re-run this
-- after they have.

update public.profiles
set is_admin = true
where discord_id in ('1327350011054526505', '1253736765986967622');
