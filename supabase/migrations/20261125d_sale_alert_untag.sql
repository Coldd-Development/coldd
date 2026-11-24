-- Sale alerts (2026-11-25): a tag a listing puts before its name ("[COMPLETE] Catch a Fish",
-- the Creator Store's search tag) is not part of the product's name, so alerts say
-- "Catch a Fish just sold on Creator Store!" and its aliases still apply.
create or replace function public.sale_alert_untag(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(trim(regexp_replace(coalesce(p, ''), '^\s*(\[[^]]*\]\s*)+', '')), '')
$$;
revoke execute on function public.sale_alert_untag(text) from public, anon, authenticated;

create or replace function public.sale_alert_enqueue(p_source text, p_ref text, p_product text, p_more int,
  p_amount numeric, p_currency text, p_sold_at timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- Only fresh sales: a backfill or re-read of old sales never alerts.
  if coalesce(p_amount, 0) <= 0 or p_sold_at is null or p_sold_at < now() - interval '2 hours' then return false; end if;
  insert into sale_alerts (source, ref, product, more, amount, currency, sold_at, push_id)
  values (p_source, p_ref, sale_alert_untag(p_product), greatest(coalesce(p_more, 0), 0), p_amount, upper(coalesce(p_currency, 'USD')), p_sold_at,
          'sale-' || regexp_replace(p_ref, '[^A-Za-z0-9]', '', 'g'))
  on conflict (ref) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform sale_alert_kick(); end if;
  return n > 0;
end $$;

create or replace function public.sale_alert_platform() returns trigger
language plpgsql security definer set search_path = public as $$
declare nm text; canon text; n int; cur text;
begin
  begin
    if coalesce(new.status, '') = 'refunded' or coalesce(new.source, '') in ('manual', 'csv', 'userscript') then return new; end if;
    if exists (select 1 from platform_sale_ignores g where g.platform = new.platform and lower(g.product_name) = lower(new.product_name)) then return new; end if;
    n := greatest(coalesce(new.quantity, 1), 1);
    nm := coalesce(sale_alert_untag(new.product_name), '');
    if n > 1 and position(', ' in nm) > 0 then nm := split_part(nm, ', ', 1); else n := 1; end if;
    select a.canonical into canon from product_name_aliases a
     where (lower(a.alias) = lower(nm) or lower(a.alias) = lower(new.product_name)) and a.price_usd is null limit 1;
    nm := coalesce(canon, nullif(trim(nm), ''));
    cur := upper(coalesce(new.currency, 'USD'));

    if new.platform = 'parcel' and cur = 'ROBUX' then
      -- The bot names a sale the group ledger already alerted: re-send it with the name,
      -- replacing the first alert on the phone (silently if it was already shown).
      update sale_alerts a set product = nm, more = n - 1, quiet = (a.sent_at is not null),
             sent_at = null, claimed_at = null, attempts = 0, error = null, send_after = now()
       where a.id = (select x.id from sale_alerts x
                      where x.source = 'parcel' and x.product is null and x.currency = 'ROBUX' and x.amount = new.amount
                        and x.sold_at between coalesce(new.sold_at, now()) - interval '10 minutes' and coalesce(new.sold_at, now()) + interval '10 minutes'
                      order by abs(extract(epoch from x.sold_at - coalesce(new.sold_at, now()))) limit 1);
      if found then perform sale_alert_kick(); return new; end if;
    end if;

    perform sale_alert_enqueue(new.platform, 'ps:' || new.id, nm, n - 1, new.amount, cur, coalesce(new.sold_at, now()));
  exception when others then raise warning 'sale alert (platform sale %): %', new.id, sqlerrm;
  end;
  return new;
end $$;
