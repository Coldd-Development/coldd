-- Robux panel (2026-11-24): the spending graph is weekly and always covers at least
-- the past 8 weeks, so admin_robux_sources returns every recorded spending day
-- (robux_daily is one row a day) whatever the range; revenue rows still follow it.
create or replace function public.admin_robux_sources(p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  since timestamptz;
  unit text;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  since := case when p_days > 0 then now() - make_interval(days => p_days) else '-infinity'::timestamptz end;
  unit := case when p_days = 1 then 'hour' else 'day' end;
  return jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_array(extract(epoch from q.b)::bigint, q.src, q.robux) order by q.b)
      from (
        select date_trunc(unit, s.created_at at time zone 'Australia/Sydney') at time zone 'Australia/Sydney' as b,
               case
                 when s.item_type = 'GamePass' and s.item_id::text in (
                   select gamepass_id from public.roblox_pool_passes where gamepass_id is not null
                   union select roblox_gamepass_id from public.orders where roblox_gamepass_id is not null
                 ) then 'site'
                 when s.item_type = 'DeveloperProduct' then 'parcel'
                 else 'misc'
               end as src,
               sum(s.amount)::bigint as robux
        from public.robux_sales s
        where s.created_at >= since
        group by 1, 2
      ) q), '[]'::jsonb),
    'first', (select min(created_at) from public.robux_sales),
    'spend', coalesce((
      select jsonb_agg(jsonb_build_array(d.day, d.robux_out) order by d.day)
      from public.robux_daily d
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.admin_robux_sources(integer) from public, anon;
grant execute on function public.admin_robux_sources(integer) to authenticated;
