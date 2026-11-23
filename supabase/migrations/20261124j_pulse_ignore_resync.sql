-- Live orders pulse (2026-11-24): the Creator Store sync re-saves the last 3 days of
-- sales every minute (same values, new updated_at), which made the marketplace part
-- of the pulse change every minute for nothing. It now changes only when a sale is
-- added or removed, refunded, or its amount changes.
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
    'b', (select count(*) || ':' || coalesce(max(purchase_id)::text, '') from public.bbb2_purchases)
  );
end;
$$;
revoke all on function public.admin_sales_pulse() from public, anon;
grant execute on function public.admin_sales_pulse() to authenticated;
