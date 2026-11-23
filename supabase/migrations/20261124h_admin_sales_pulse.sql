-- Admin live orders (2026-11-24): one tiny call tells the admin whether any sale
-- source changed, so the Orders page can check every few seconds and reload a
-- source (and slide new orders in) only when something actually changed.
-- o = website orders (count, newest, paid times, status mix), p = marketplace
-- sales (ClearlyDev, Creator Store, Parcel, Payhip), b = BuiltByBit purchases.
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
    'p', (select count(*) || ':' || coalesce(max(updated_at)::text, '') || ':' || coalesce(max(created_at)::text, '') from public.platform_sales),
    'b', (select count(*) || ':' || coalesce(max(purchase_id)::text, '') from public.bbb2_purchases)
  );
end;
$$;
revoke all on function public.admin_sales_pulse() from public, anon;
grant execute on function public.admin_sales_pulse() to authenticated;
