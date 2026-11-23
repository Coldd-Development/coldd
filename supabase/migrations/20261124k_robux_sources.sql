-- Robux panel (2026-11-24).
-- robux_daily: Robux in / out of the group per Sydney day. Roblox only gives rolling
-- totals (past day / week / month / year), so admin-robux-revenue records the "past
-- day" figures in the first hour after midnight Sydney, which is the day just ended.
create table if not exists public.robux_daily (
  day date primary key,
  robux_out integer not null default 0,
  robux_in integer not null default 0,
  captured_at timestamptz not null default now()
);
alter table public.robux_daily enable row level security;

-- Revenue by source for the Analytics range: coldd.dev (the storefront's checkout
-- passes), Parcel (developer products) and everything else, per hour (24h) or per
-- Sydney day, plus the recorded daily spending. Admin only.
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
      where p_days <= 0 or d.day >= (now() at time zone 'Australia/Sydney')::date - p_days
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.admin_robux_sources(integer) from public, anon;
grant execute on function public.admin_robux_sources(integer) to authenticated;
