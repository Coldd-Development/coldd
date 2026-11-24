-- Robux spending history (2026-11-24). robux_spend_log: the group audit log's
-- "Spend Group Funds" entries (one-time payouts and other spending), read by
-- admin-robux-revenue once the sync account has the group's "View audit log"
-- permission. Days before the daily records start (robux_daily) take their
-- spending from here, so the spending graph and the minimum balance have history.
create table if not exists public.robux_spend_log (
  id text primary key,
  created_at timestamptz not null,
  robux integer not null,
  item text,
  actor_role text,
  description jsonb,
  synced_at timestamptz not null default now()
);
alter table public.robux_spend_log enable row level security;
create index if not exists robux_spend_log_created_idx on public.robux_spend_log (created_at);

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
                 when s.item_type = 'GamePass' and (s.item_name ilike 'coldd order pass%' or s.item_id::text in (
                   select gamepass_id from public.roblox_pool_passes where gamepass_id is not null
                   union select roblox_gamepass_id from public.orders where roblox_gamepass_id is not null
                 )) then 'site'
                 when s.item_type = 'DeveloperProduct' then 'parcel'
                 else 'misc'
               end as src,
               sum(s.amount)::bigint as robux
        from public.robux_sales s
        where s.created_at >= since
        group by 1, 2
      ) q), '[]'::jsonb),
    'first', (select min(created_at) from public.robux_sales),
    -- Spending per Sydney day: the daily record where there is one, else the audit log's sum.
    'spend', coalesce((
      select jsonb_agg(jsonb_build_array(x.day, x.robux) order by x.day)
      from (
        select d.day, d.robux_out as robux from public.robux_daily d
        union all
        select l.day, l.robux from (
          select (created_at at time zone 'Australia/Sydney')::date as day, sum(robux)::int as robux
          from public.robux_spend_log group by 1
        ) l
        where not exists (select 1 from public.robux_daily d2 where d2.day = l.day)
      ) x
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.admin_robux_sources(integer) from public, anon;
grant execute on function public.admin_robux_sources(integer) to authenticated;
