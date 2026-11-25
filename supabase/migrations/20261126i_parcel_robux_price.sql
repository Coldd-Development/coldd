-- Parcel Robux prices. A developer product named after its price ("99", "99 - 1") is that
-- price. One named after the product has only the group's take to go on, and several prices
-- leave the same take (99 and 100 both give 70), so the one ending in 9 wins (Parcel prices
-- are 99, 149, 199, 299...). Used by the sale alert, the admin's ledger figures and
-- _shared/parcel_feed.ts (same rule).
create or replace function public.parcel_robux_price(p_name text, p_net numeric) returns int
language plpgsql immutable set search_path = public as $$
declare base int; p int; best int;
begin
  if p_name ~ '^\s*\d+(\s*-\s*\d+)?\s*$' then return (regexp_match(p_name, '(\d+)'))[1]::int; end if;
  if p_net is null or p_net <= 0 then return null; end if;
  base := round(p_net / 0.7)::int;
  for p in greatest(1, base - 3) .. base + 3 loop
    if p - floor(p * 3 / 10.0)::int = p_net then
      if p % 10 = 9 then return p; end if;
      if best is null then best := p; end if;
    end if;
  end loop;
  return coalesce(best, base);
end $$;

-- The ledger alert waits up to 2 minutes for the Discord bot to name the sale (the bot's
-- order then sends it at once, named); if no name comes it goes out unnamed.
create or replace function public.sale_alert_parcel_ledger()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare price int;
begin
  begin
    if new.item_type <> 'DeveloperProduct' then return new; end if;
    price := parcel_robux_price(new.item_name, new.amount);
    -- The bot already alerted this sale (with its name): just link it.
    update sale_alerts a set ledger_ref = 'rbx:' || new.id_hash
     where a.id = (select x.id from sale_alerts x
                    where x.source = 'parcel' and x.ref like 'ps:%' and x.ledger_ref is null and x.currency = 'ROBUX' and x.amount = price
                      and x.sold_at between new.created_at - interval '10 minutes' and new.created_at + interval '10 minutes'
                    order by abs(extract(epoch from x.sold_at - new.created_at)) limit 1);
    if found then return new; end if;
    if sale_alert_enqueue('parcel', 'rbx:' || new.id_hash, null, 0, price, 'ROBUX', new.created_at) then
      update sale_alerts set send_after = now() + interval '2 minutes' where ref = 'rbx:' || new.id_hash and sent_at is null;
    end if;
  exception when others then raise warning 'sale alert (ledger %): %', new.id_hash, sqlerrm;
  end;
  return new;
end $function$;

create or replace function public.admin_parcel_robux()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  -- Ledger sales the Discord bot matched to a Parcel purchase are orders in platform_sales
  -- (ledger_ref) and are left out here, so the admin never counts them twice.
  return coalesce((
    select jsonb_agg(jsonb_build_array(extract(epoch from s.created_at)::bigint, parcel_robux_price(s.item_name, s.amount), s.amount) order by s.created_at)
    from public.robux_sales s
    where s.item_type = 'DeveloperProduct'
      and not exists (select 1 from public.platform_sales p where p.ledger_ref = s.id_hash)
  ), '[]'::jsonb);
end;
$function$;
