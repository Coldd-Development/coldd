-- Sale alerts (2026-11-27): an order of several products sends one phone alert per
-- product, each at its own price ("Sale for A$3.00!" / "Skyscraper Restaurant just sold
-- on ClearlyDev!"), instead of one "Skyscraper Restaurant + 3 more" alert for the total.
-- The prices are the platform's own, from the sale's raw.items (sales-mail-poll saves
-- them from the ClearlyDev order email's "Products Ordered" list). When they do not add
-- up to what was paid (a coupon), each is scaled so the alerts still add up to the order.
-- A sale without priced items alerts as before (one alert, "+ N more").
-- Refs are 'ps:<sale id>:<n>' (n from 0), so each product gets its own push.
create or replace function public.sale_alert_platform() returns trigger
language plpgsql security definer set search_path = public as $$
declare nm text; canon text; n int; cur text; items jsonb; it jsonb; total numeric; amt numeric; k int;
begin
  begin
    if coalesce(new.status, '') = 'refunded' or coalesce(new.source, '') in ('manual', 'csv', 'userscript') then return new; end if;
    if exists (select 1 from platform_sale_ignores g where g.platform = new.platform and lower(g.product_name) = lower(new.product_name)) then return new; end if;
    cur := upper(coalesce(new.currency, 'USD'));

    if jsonb_typeof(new.raw -> 'items') = 'array' then items := new.raw -> 'items'; end if;
    if items is not null and jsonb_array_length(items) > 1
       and not exists (select 1 from jsonb_array_elements(items) e
                        where (case when jsonb_typeof(e -> 'amount') = 'number' then (e ->> 'amount')::numeric else 0 end) <= 0
                           or coalesce(sale_alert_untag(e ->> 'name'), '') = '') then
      select sum((e ->> 'amount')::numeric) into total from jsonb_array_elements(items) e;
      for k in 0 .. jsonb_array_length(items) - 1 loop
        it := items -> k;
        nm := sale_alert_untag(it ->> 'name');
        continue when exists (select 1 from platform_sale_ignores g where g.platform = new.platform
                                and lower(g.product_name) in (lower(it ->> 'name'), lower(nm)));
        amt := (it ->> 'amount')::numeric;
        if new.amount is not null and abs(total - new.amount) > 0.01 then amt := round(amt * new.amount / total, 2); end if;
        -- Same alias rules as the admin's canonName: a priced alias when the price agrees, else the plain one.
        canon := null;
        if cur = 'USD' then
          select a.canonical into canon from product_name_aliases a
           where lower(a.alias) = lower(nm) and a.price_usd is not null and abs(a.price_usd - amt) <= greatest(0.5, a.price_usd * 0.1)
           order by abs(a.price_usd - amt) limit 1;
        end if;
        if canon is null then
          select a.canonical into canon from product_name_aliases a where lower(a.alias) = lower(nm) and a.price_usd is null limit 1;
        end if;
        perform sale_alert_enqueue(new.platform, 'ps:' || new.id || ':' || k, coalesce(canon, nm), 0, amt, cur, coalesce(new.sold_at, now()));
      end loop;
      return new;
    end if;

    n := greatest(coalesce(new.quantity, 1), 1);
    nm := coalesce(sale_alert_untag(new.product_name), '');
    if n > 1 and position(', ' in nm) > 0 then nm := split_part(nm, ', ', 1); else n := 1; end if;
    select a.canonical into canon from product_name_aliases a
     where (lower(a.alias) = lower(nm) or lower(a.alias) = lower(new.product_name)) and a.price_usd is null limit 1;
    nm := coalesce(canon, nullif(trim(nm), ''));

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
