-- Stop returning internal columns to the public API.
--
--   * products.storage_path   internal download file path (useless without a signed
--                             link, but there is no reason for anyone to read it)
--   * site_status.maintenance_allow_user_ids   the tester allowlist (user UUIDs)
--
-- Apply in two steps so the live site never breaks:
--   PART 1 (additive, safe any time): new RPC functions.
--   PART 2 (run AFTER the matching site code is live): the column revokes.
--
-- Anything that needs these values now goes through the RPCs below, or an edge
-- function using the service role (which is unaffected by these grants).
-- NOTE: with column grants, a NEW products / site_status column is invisible to the
-- browser until it is added to the GRANT lists in PART 2.

-- ============================== PART 1 ==============================

-- "Am I on the maintenance tester allowlist?" - answers only for the caller.
create or replace function public.is_maintenance_tester()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select auth.uid() = any (maintenance_allow_user_ids) from public.site_status where id = true),
    false
  );
$$;
revoke all on function public.is_maintenance_tester() from public, anon;
grant execute on function public.is_maintenance_tester() to authenticated;

-- Full allowlist, admins only (admin Site Access panel).
create or replace function public.admin_maintenance_allowlist()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select case when public.is_admin()
    then coalesce((select maintenance_allow_user_ids from public.site_status where id = true), '{}')
    else '{}'::uuid[] end;
$$;
revoke all on function public.admin_maintenance_allowlist() from public, anon;
grant execute on function public.admin_maintenance_allowlist() to authenticated;

-- Download paths, admins only (admin product edit form).
create or replace function public.admin_product_storage_paths()
returns table (id uuid, storage_path text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.storage_path from public.products p where public.is_admin();
$$;
revoke all on function public.admin_product_storage_paths() from public, anon;
grant execute on function public.admin_product_storage_paths() to authenticated;

-- ============================== PART 2 ==============================
-- (applied 2026-10-07, after the matching code was live)

revoke select on public.products from public, anon, authenticated;
grant select (
  id, slug, title, description, long_description, image, gallery, video, cat, subcat,
  platform, page, tech, price_usd, was_price, robux_price, resell_available,
  resell_price_usd, resell_robux_price, roblox_gamepass_id, roblox_universe_id,
  version, versions, changelog, last_released_version, featured, featured_order,
  priority, rating, reviews_count, is_active, weekly_deal, weekly_deal_auto,
  weekly_deal_excluded, weekly_deal_pct, created_at, updated_at
) on public.products to anon, authenticated;

revoke select on public.site_status from public, anon, authenticated;
grant select (id, mode, maintenance_message, maintenance_ends_at, updated_at)
  on public.site_status to anon, authenticated;
