-- Sale alerts (2026-11-25): a push to the owner's iPhone, through the free Bark app,
-- for every sale on every platform ("Sale for $24.99!" / "Catch a Fish just sold for
-- $24.99 on BuiltByBit!").
--
-- How it flows:
--   1. A trigger on each sales table puts one row per new sale in public.sale_alerts
--      (coldd.dev orders when paid, BuiltByBit purchases, Creator Store / ClearlyDev /
--      Payhip / Parcel rows in platform_sales, Parcel developer products in the group
--      sale ledger). Only fresh sales count: anything sold more than 2 hours before it
--      arrives (a backfill or a deep re-read), imports by hand, refunds, tests and admin
--      grants never alert. Each sale alerts once (ref is unique).
--   2. The trigger pokes the sale-alerts edge function (pg_net, x-cron-secret read from
--      the vault), the syncs that write sales flush the queue when they finish, and a
--      cron job every minute catches anything left.
--   3. The function sends each alert to every phone added in Site Management > Phone
--      alerts, encrypted (AES-256-CBC with the phone's own key), so Bark's relay and
--      Apple only carry ciphertext.
-- Parcel: the group ledger alerts at once with the price ("A Parcel product ..."). When
-- the Discord bot later writes the same sale to platform_sales with its name, the alert
-- is re-sent with the same push id, which replaces it on the phone silently. A bot row
-- that arrives first alerts with the name, and the ledger row then sends nothing.
-- Every trigger catches its own errors: an alert problem never blocks a sale being saved.

-- ---- Tables ----
create table if not exists public.sale_alert_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  platforms jsonb not null default '{"site":true,"builtbybit":true,"creatorstore":true,"clearlydev":true,"payhip":true,"parcel":true}',
  min_usd numeric not null default 0,
  quiet_start time,                 -- Sydney time; alerts in between arrive silently
  quiet_end time,
  sound text not null default 'paymentsuccess',   -- a Bark sound name
  sound_url text,                   -- a .caf the phone downloads once (the cha-ching)
  level text not null default 'timeSensitive' check (level in ('active', 'timeSensitive', 'critical')),
  updated_at timestamptz not null default now()
);
insert into public.sale_alert_settings (id) values (true) on conflict do nothing;

create table if not exists public.sale_alert_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  server text not null default 'https://api.day.app',
  bark_key text not null,
  enc_key text not null,            -- 32 characters: AES-256-CBC, entered in Bark's encryption settings
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_error text
);

create table if not exists public.sale_alerts (
  id bigint generated always as identity primary key,
  source text not null,             -- site | builtbybit | creatorstore | clearlydev | payhip | parcel
  ref text not null unique,         -- the sale: order:<id>, bbb:<id>, ps:<id>, rbx:<ledger id>
  product text,                     -- null: not named yet (a Parcel ledger sale)
  more int not null default 0,      -- other items in the same order
  amount numeric not null,          -- what the buyer paid, in currency
  currency text not null,           -- USD, AUD, EUR, ROBUX ...
  sold_at timestamptz not null,
  push_id text not null,            -- Bark notification id: a later push with it replaces this one
  quiet boolean not null default false,
  ledger_ref text,                  -- Parcel: the ledger sale matched to a bot row
  created_at timestamptz not null default now(),
  send_after timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts int not null default 0,
  error text
);
create index if not exists sale_alerts_due on public.sale_alerts (send_after) where sent_at is null;
create index if not exists sale_alerts_parcel on public.sale_alerts (sold_at) where source = 'parcel';

alter table public.sale_alert_settings enable row level security;
alter table public.sale_alert_devices enable row level security;
alter table public.sale_alerts enable row level security;
revoke all on public.sale_alert_settings, public.sale_alert_devices, public.sale_alerts from anon, authenticated;

-- ---- The shared cron secret, moved into the vault (never typed out) ----
do $$
declare s text;
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    select substring(command from 'x-cron-secret[''"]\s*[,:]\s*[''"]([^''"]+)') into s
      from cron.job where jobname = 'creator-store-sync';
    if s is not null then
      perform vault.create_secret(s, 'cron_secret', 'x-cron-secret header for edge functions called from the database');
    end if;
  end if;
end $$;

-- ---- Queue + poke ----
create or replace function public.sale_alert_kick() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://ekinmytmudjwfaqaqswp.supabase.co/functions/v1/sale-alerts',
    body := '{"action":"flush"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1)),
    timeout_milliseconds := 20000);
exception when others then
  raise warning 'sale alert kick: %', sqlerrm;
end $$;

create or replace function public.sale_alert_enqueue(p_source text, p_ref text, p_product text, p_more int,
  p_amount numeric, p_currency text, p_sold_at timestamptz) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- Only fresh sales: a backfill or re-read of old sales never alerts.
  if coalesce(p_amount, 0) <= 0 or p_sold_at is null or p_sold_at < now() - interval '2 hours' then return false; end if;
  insert into sale_alerts (source, ref, product, more, amount, currency, sold_at, push_id)
  values (p_source, p_ref, nullif(trim(p_product), ''), greatest(coalesce(p_more, 0), 0), p_amount, upper(coalesce(p_currency, 'USD')), p_sold_at,
          'sale-' || regexp_replace(p_ref, '[^A-Za-z0-9]', '', 'g'))
  on conflict (ref) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform sale_alert_kick(); end if;
  return n > 0;
end $$;

-- ---- Triggers ----
-- coldd.dev: an order when it becomes paid (tests and admin grants never alert).
create or replace function public.sale_alert_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_title text; n int;
begin
  begin
    if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid')
       and not coalesce(new.is_test, false) and coalesce(new.source, '') <> 'granted' then
      select count(*), (array_agg(title order by created_at, id))[1] into n, first_title from order_items where order_id = new.id;
      perform sale_alert_enqueue('site', 'order:' || new.id,
        coalesce(first_title, 'A coldd.dev order'), greatest(coalesce(n, 1), 1) - 1,
        case when new.currency = 'robux' then new.total_robux else new.total_usd end,
        case when new.currency = 'robux' then 'ROBUX' else 'USD' end,
        coalesce(new.paid_at, now()));
    end if;
  exception when others then raise warning 'sale alert (order %): %', new.id, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists sale_alert_order on public.orders;
create trigger sale_alert_order after insert or update of status on public.orders
  for each row execute function public.sale_alert_order();

-- BuiltByBit: our catalogue name when the listing was imported, else the listing title
-- up to its first " | ".
create or replace function public.sale_alert_bbb() returns trigger
language plpgsql security definer set search_path = public as $$
declare t text; nm text;
begin
  begin
    select r.title into t from bbb2_resources r where r.resource_id = new.resource_id;
    select p.title into nm from bbb_imports i join products p on p.id = i.product_id where i.resource_id = new.resource_id limit 1;
    nm := coalesce(nm, nullif(trim(split_part(coalesce(t, ''), ' | ', 1)), ''), 'A BuiltByBit product');
    if new.addon_title is not null and new.addon_title <> '' then nm := nm || ' (' || new.addon_title || ')'; end if;
    perform sale_alert_enqueue('builtbybit', 'bbb:' || new.purchase_id, nm, 0, new.price_final, coalesce(new.currency, 'USD'), coalesce(new.created_at, now()));
  exception when others then raise warning 'sale alert (bbb %): %', new.purchase_id, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists sale_alert_bbb on public.bbb2_purchases;
create trigger sale_alert_bbb after insert on public.bbb2_purchases
  for each row execute function public.sale_alert_bbb();

-- Creator Store / ClearlyDev / Payhip / Parcel (the bot) rows. A cart names its first
-- product ("+ 2 more"); names go through product_name_aliases.
create or replace function public.sale_alert_platform() returns trigger
language plpgsql security definer set search_path = public as $$
declare nm text; canon text; n int; cur text;
begin
  begin
    if coalesce(new.status, '') = 'refunded' or coalesce(new.source, '') in ('manual', 'csv', 'userscript') then return new; end if;
    if exists (select 1 from platform_sale_ignores g where g.platform = new.platform and lower(g.product_name) = lower(new.product_name)) then return new; end if;
    n := greatest(coalesce(new.quantity, 1), 1);
    nm := coalesce(new.product_name, '');
    if n > 1 and position(', ' in nm) > 0 then nm := split_part(nm, ', ', 1); else n := 1; end if;
    select a.canonical into canon from product_name_aliases a where lower(a.alias) = lower(nm) and a.price_usd is null limit 1;
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
drop trigger if exists sale_alert_platform on public.platform_sales;
create trigger sale_alert_platform after insert on public.platform_sales
  for each row execute function public.sale_alert_platform();

-- Parcel through the group sale ledger: developer products are named after their price.
create or replace function public.sale_alert_parcel_ledger() returns trigger
language plpgsql security definer set search_path = public as $$
declare price int;
begin
  begin
    if new.item_type <> 'DeveloperProduct' then return new; end if;
    price := case when new.item_name ~ '^\s*\d+(\s*-\s*\d+)?\s*$' then (regexp_match(new.item_name, '(\d+)'))[1]::int
                  else round(new.amount / 0.7)::int end;
    -- The bot already alerted this sale (with its name): just link it.
    update sale_alerts a set ledger_ref = 'rbx:' || new.id_hash
     where a.id = (select x.id from sale_alerts x
                    where x.source = 'parcel' and x.ref like 'ps:%' and x.ledger_ref is null and x.currency = 'ROBUX' and x.amount = price
                      and x.sold_at between new.created_at - interval '10 minutes' and new.created_at + interval '10 minutes'
                    order by abs(extract(epoch from x.sold_at - new.created_at)) limit 1);
    if found then return new; end if;
    perform sale_alert_enqueue('parcel', 'rbx:' || new.id_hash, null, 0, price, 'ROBUX', new.created_at);
  exception when others then raise warning 'sale alert (ledger %): %', new.id_hash, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists sale_alert_parcel_ledger on public.robux_sales;
create trigger sale_alert_parcel_ledger after insert on public.robux_sales
  for each row execute function public.sale_alert_parcel_ledger();

-- ---- Sender side (service role only) ----
create or replace function public.sale_alerts_claim(p_limit int default 20) returns setof public.sale_alerts
language sql security definer set search_path = public as $$
  update sale_alerts a set claimed_at = now(), attempts = a.attempts + 1
   where a.id in (select x.id from sale_alerts x
                   where x.sent_at is null and x.send_after <= now() and x.attempts < 5
                     and (x.claimed_at is null or x.claimed_at < now() - interval '2 minutes')
                   order by x.id limit p_limit for update skip locked)
  returning a.*;
$$;
revoke all on function public.sale_alerts_claim(int) from public, anon, authenticated;
revoke all on function public.sale_alert_enqueue(text, text, text, int, numeric, text, timestamptz) from public, anon, authenticated;
revoke all on function public.sale_alert_kick() from public, anon, authenticated;

-- ---- Admin (Site Management > Phone alerts) ----
create or replace function public.admin_sale_alerts_state() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) - 'id' from sale_alert_settings s where s.id),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'server', d.server,
        'key_tail', right(d.bark_key, 4), 'enabled', d.enabled, 'created_at', d.created_at,
        'last_sent_at', d.last_sent_at, 'last_error', d.last_error) order by d.created_at) from sale_alert_devices d), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(to_jsonb(r) - 'claimed_at' - 'ledger_ref' order by r.id desc) from (
        select * from sale_alerts order by id desc limit 15) r), '[]'::jsonb));
end $$;

-- Adds a phone from the link Bark shows (https://api.day.app/<key>/...) or the bare key, and
-- makes its encryption key (shown once in the admin to type into Bark).
create or replace function public.admin_sale_alert_device_add(p_name text, p_link text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare m text[]; srv text; k text; ek text; new_id uuid;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  m := regexp_match(trim(coalesce(p_link, '')), '^(https?://[^/\s]+)/([A-Za-z0-9]{8,64})');
  if m is not null then srv := m[1]; k := m[2];
  elsif trim(coalesce(p_link, '')) ~ '^[A-Za-z0-9]{8,64}$' then srv := 'https://api.day.app'; k := trim(p_link);
  else raise exception 'Paste the link Bark shows (it starts with https://api.day.app/).';
  end if;
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', 1 + (get_byte(b, i) % 57), 1), '')
    into ek from gen_random_bytes(32) b, generate_series(0, 31) i;
  insert into sale_alert_devices (name, server, bark_key, enc_key)
  values (coalesce(nullif(trim(p_name), ''), 'iPhone'), srv, k, ek) returning id into new_id;
  return jsonb_build_object('id', new_id, 'enc_key', ek);
end $$;

create or replace function public.admin_sale_alert_device_secret(p_id uuid) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  return (select enc_key from sale_alert_devices where id = p_id);
end $$;

create or replace function public.admin_sale_alert_device_update(p_id uuid, p_enabled boolean default null, p_remove boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  if p_remove then delete from sale_alert_devices where id = p_id; return; end if;
  update sale_alert_devices set enabled = coalesce(p_enabled, enabled) where id = p_id;
end $$;

create or replace function public.admin_sale_alert_settings_save(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update sale_alert_settings s set
    enabled = coalesce((p->>'enabled')::boolean, s.enabled),
    platforms = coalesce(p->'platforms', s.platforms),
    min_usd = coalesce((p->>'min_usd')::numeric, s.min_usd),
    quiet_start = case when p ? 'quiet_start' then nullif(p->>'quiet_start', '')::time else s.quiet_start end,
    quiet_end = case when p ? 'quiet_end' then nullif(p->>'quiet_end', '')::time else s.quiet_end end,
    sound = coalesce(nullif(p->>'sound', ''), s.sound),
    sound_url = case when p ? 'sound_url' then nullif(p->>'sound_url', '') else s.sound_url end,
    level = coalesce(nullif(p->>'level', ''), s.level),
    updated_at = now()
  where s.id;
end $$;

revoke all on function public.admin_sale_alerts_state(), public.admin_sale_alert_device_add(text, text),
  public.admin_sale_alert_device_secret(uuid), public.admin_sale_alert_device_update(uuid, boolean, boolean),
  public.admin_sale_alert_settings_save(jsonb) from public, anon;
grant execute on function public.admin_sale_alerts_state(), public.admin_sale_alert_device_add(text, text),
  public.admin_sale_alert_device_secret(uuid), public.admin_sale_alert_device_update(uuid, boolean, boolean),
  public.admin_sale_alert_settings_save(jsonb) to authenticated;

-- ---- Safety net: every minute, same call as creator-store-sync (secret not typed out) ----
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'sale-alerts') then
    perform cron.schedule('sale-alerts', '* * * * *',
      (select replace(command, 'creator-store-sync', 'sale-alerts') from cron.job where jobname = 'creator-store-sync'));
  end if;
end $$;
