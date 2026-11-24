-- Parcel's Robux revenue on the admin's platform figures (2026-11-24).
-- Parcel sells through developer products in the group's hub, which show up in the
-- group sale ledger (robux_sales, item_type DeveloperProduct). The products are named
-- after their price ("99", "199", "99 - 1"), so the price the buyer paid is read from
-- the name; for any other name it is the Robux the group got back before Roblox's 30%.
-- Returns [unix seconds, price paid, Robux the group got] per sale, oldest first. Admin only.
create or replace function public.admin_parcel_robux()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_array(
      extract(epoch from s.created_at)::bigint,
      case when s.item_name ~ '^\s*\d+(\s*-\s*\d+)?\s*$' then (regexp_match(s.item_name, '(\d+)'))[1]::int
           else round(s.amount / 0.7)::int end,
      s.amount) order by s.created_at)
    from public.robux_sales s
    where s.item_type = 'DeveloperProduct'
  ), '[]'::jsonb);
end;
$$;
revoke all on function public.admin_parcel_robux() from public, anon;
grant execute on function public.admin_parcel_robux() to authenticated;

-- The live-orders pulse also says when Parcel's Robux sales changed ('r').
create or replace function public.admin_sales_pulse()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  return jsonb_build_object(
    'o', (select count(*) || ':' || coalesce(max(created_at)::text, '') || ':' || coalesce(max(paid_at)::text, '') from public.orders)
         || '|' || coalesce((select string_agg(status || '=' || n, ',' order by status) from (select status, count(*) n from public.orders group by status) s), ''),
    'p', (select count(*) || ':' || coalesce(max(created_at)::text, '') || ':' || count(*) filter (where status = 'refunded')
           || ':' || coalesce(round(sum(amount), 2)::text, '') || ':' || coalesce(round(sum(amount_usd), 2)::text, '') from public.platform_sales),
    'b', (select count(*) || ':' || coalesce(max(purchase_id)::text, '') from public.bbb2_purchases),
    'r', (select count(*) || ':' || coalesce(max(created_at)::text, '') from public.robux_sales where item_type = 'DeveloperProduct')
  );
end;
$$;
revoke all on function public.admin_sales_pulse() from public, anon;
grant execute on function public.admin_sales_pulse() to authenticated;
