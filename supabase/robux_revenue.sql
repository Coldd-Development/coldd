-- Group Robux revenue (filled by the admin-robux-revenue edge function).
--
--   robux_sales   one row per sale in the group's Roblox sale ledger. id_hash is Roblox's unique key
--                 (the ledger's numeric id is always 0). amount is what the group receives, AFTER
--                 Roblox's 30% cut. is_pending = Roblox still holds the Robux.
--   robux_state   sync status plus Roblox's own summary totals and our reconciliation against them.
--
-- Buyer ids are personal data: robux_sales has NO client access at all. The admin panel only ever
-- sees the aggregates returned by admin_robux_stats() (is_admin only).
-- (The older roblox_group_* tables from the July attempt are left alone and unused.)

create table if not exists public.robux_sales (
  id_hash     text primary key,
  created_at  timestamptz not null,
  amount      integer not null,
  item_id     bigint,
  item_name   text,
  item_type   text,
  buyer_id    bigint,
  is_pending  boolean not null default false,
  synced_at   timestamptz not null default now()
);
create index if not exists robux_sales_created_idx on public.robux_sales (created_at);

create table if not exists public.robux_state (
  id            boolean primary key default true check (id),
  last_sync_at  timestamptz,
  last_full_at  timestamptz,
  last_error    text,
  summary       jsonb,
  reconcile     jsonb,
  resume_cursor text,
  updated_at    timestamptz not null default now()
);
insert into public.robux_state (id) values (true) on conflict do nothing;

alter table public.robux_sales enable row level security;
alter table public.robux_state enable row level security;
do $$ begin create policy "robux_state_admin_select" on public.robux_state for select using (public.is_admin());
exception when duplicate_object then null; end $$;
revoke all on public.robux_sales, public.robux_state from public, anon, authenticated;
grant select on public.robux_state to authenticated;

-- Aggregates for the Analytics tab. p_days = 0 means all time; otherwise the last p_days x 24 hours.
create or replace function public.admin_robux_stats(p_days integer)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare since timestamptz; prev_since timestamptz; res jsonb;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  since := case when p_days > 0 then now() - (p_days * interval '1 day') else '-infinity'::timestamptz end;
  prev_since := case when p_days > 0 then since - (p_days * interval '1 day') else null end;

  select jsonb_build_object(
    'total',        coalesce(sum(amount) filter (where created_at >= since), 0),
    'sales',        count(*) filter (where created_at >= since),
    'buyers',       count(distinct buyer_id) filter (where created_at >= since),
    'pending',      coalesce(sum(amount) filter (where created_at >= since and is_pending), 0),
    'prev_total',   case when prev_since is null then null else coalesce(sum(amount) filter (where created_at >= prev_since and created_at < since), 0) end,
    'prev_sales',   case when prev_since is null then null else count(*) filter (where created_at >= prev_since and created_at < since) end,
    'first_sale',   min(created_at),
    'last_sale',    max(created_at)
  ) into res from public.robux_sales;

  res := res || jsonb_build_object(
    'repeat_buyers', (select count(*) from (select buyer_id from public.robux_sales where created_at >= since and buyer_id is not null group by buyer_id having count(*) > 1) r),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'robux', r, 'sales', n) order by d)
                       from (select (created_at at time zone 'UTC')::date as d, sum(amount) as r, count(*) as n
                             from public.robux_sales where created_at >= since group by 1) x), '[]'::jsonb),
    'types', coalesce((select jsonb_agg(jsonb_build_object('type', t, 'robux', r, 'sales', n) order by r desc)
                       from (select coalesce(item_type, 'Unknown') as t, sum(amount) as r, count(*) as n
                             from public.robux_sales where created_at >= since group by 1) x), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', nm, 'type', t, 'robux', r, 'sales', n) order by r desc)
                           from (select coalesce(item_name, 'Unknown') as nm, coalesce(item_type, 'Unknown') as t, sum(amount) as r, count(*) as n
                                 from public.robux_sales where created_at >= since group by 1, 2 order by r desc limit 10) x), '[]'::jsonb),
    'weekday', coalesce((select jsonb_agg(jsonb_build_object('dow', dw, 'robux', r, 'sales', n) order by dw)
                         from (select extract(dow from created_at at time zone 'UTC')::int as dw, sum(amount) as r, count(*) as n
                               from public.robux_sales where created_at >= since group by 1) x), '[]'::jsonb),
    'best_days', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'robux', r, 'sales', n) order by r desc)
                           from (select (created_at at time zone 'UTC')::date as d, sum(amount) as r, count(*) as n
                                 from public.robux_sales where created_at >= since group by 1 order by r desc limit 5) x), '[]'::jsonb)
  );
  return res;
end $$;
revoke all on function public.admin_robux_stats(integer) from public, anon;
grant execute on function public.admin_robux_stats(integer) to authenticated;
