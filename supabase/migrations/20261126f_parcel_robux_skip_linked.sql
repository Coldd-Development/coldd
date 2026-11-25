-- The admin's Parcel ledger feed leaves out ledger sales the Discord bot matched to a Parcel
-- purchase (platform_sales.ledger_ref); those are orders now.
create or replace function public.admin_parcel_robux()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
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
      and not exists (select 1 from public.platform_sales p where p.ledger_ref = s.id_hash)
  ), '[]'::jsonb);
end;
$function$;
