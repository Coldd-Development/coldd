-- supabase/prerelease-cleanup.sql
--
-- One-off: wipe test / placeholder data before launch.
-- RUN BY HAND in the Supabase SQL editor. Nothing here runs automatically.
--
-- How to use:
--   1. Run STEP 0 on its own and read the numbers (what is about to go).
--   2. Run the whole transaction (STEP 1 onward). It ends with ROLLBACK, so the
--      first run changes nothing and just prints the "after" counts.
--   3. If the counts look right, change the final `rollback;` to `commit;` and
--      run it again. A transaction either fully applies or not at all.
--
-- KEPT on purpose: Aura VFX Asset Pack (and its legal row), site settings,
-- email automation settings, consent_log (a legal record), Discord/social
-- history, and Roblox group revenue.
-- NOT touched here: test user accounts and the admin audit log. See the
-- commented blocks near the bottom if you want those gone too.

-- ---------------------------------------------------------------- STEP 0
-- Preview. Run this block first.
select 'products to delete' as what, count(*) from products where slug <> 'aura-vfx-asset-pack'
union all select 'orders (all)', count(*) from orders
union all select 'order_items (all)', count(*) from order_items
union all select 'reviews (all)', count(*) from reviews
union all select 'wishlist_items', count(*) from wishlist_items
union all select 'bundle_deals', count(*) from bundle_deals
union all select 'page_views', count(*) from page_views
union all select 'client_events', count(*) from client_events
union all select 'client_errors', count(*) from client_errors
union all select 'cart_snapshots', count(*) from cart_snapshots
union all select 'email_events', count(*) from email_events
union all select 'email_automation_sends', count(*) from email_automation_sends
union all select 'notifications', count(*) from notifications
union all select 'rate_limits', count(*) from rate_limits;

-- Who placed the orders? Check for any REAL customer before you commit.
select o.created_at::date as day, o.status, p.email, o.total_usd
from orders o left join profiles p on p.id = o.user_id
order by o.created_at desc;

-- ---------------------------------------------------------------- STEP 1
begin;

-- 1a. Placeholder products and everything hanging off them.
delete from order_items   where product_id in (select id from products where slug <> 'aura-vfx-asset-pack');
delete from reviews       where product_id in (select id from products where slug <> 'aura-vfx-asset-pack');
delete from wishlist_items where product_id in (select id from products where slug <> 'aura-vfx-asset-pack');
delete from product_legal where product_id in (select id from products where slug <> 'aura-vfx-asset-pack');
delete from products      where slug <> 'aura-vfx-asset-pack';

-- 1b. Bundles were built from the placeholder products.
delete from bundle_deals;

-- 1c. Test orders. Aura has no sales yet, so every remaining order is a test.
delete from order_items;
delete from orders;

-- 1d. Test traffic, funnel events, error log, carts, email logs.
delete from page_views;
delete from client_events;
delete from client_errors;
delete from cart_snapshots;
delete from email_events;
delete from email_automation_sends;
delete from notifications;
delete from rate_limits;
delete from email_otps;

-- After counts.
select 'products left' as what, count(*) from products
union all select 'orders left', count(*) from orders
union all select 'page_views left', count(*) from page_views;

-- >>> Change this to `commit;` once the numbers above look right.
rollback;

-- ---------------------------------------------------------------- OPTIONAL
-- Separate runs. Review the preview select first, then run the delete.

-- Test coupons: see what exists, then delete the ones that were only for testing.
--   select code, active, usage_count from coupons order by created_at;
--   delete from coupons where code in ('TESTCODE1', 'TESTCODE2');

-- Test marketing sign-ups:
--   select email from marketing_optins;
--   delete from marketing_optins where email in ('test@example.com');

-- Test accounts (customer-facing profiles). Delete the auth user and the profile
-- cascades; do this from Supabase > Authentication > Users, or:
--   select id, email, created_at from profiles order by created_at;
--   -- then remove each test user in the dashboard (it also clears their sessions).

-- Admin audit log (history of admin actions during setup). Keeping it is
-- normally better for accountability; only clear it if you really want a blank slate:
--   delete from admin_audit_log;
