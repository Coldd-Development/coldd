begin;

alter table public.orders add column if not exists receipt_email text;
alter table public.products add column if not exists email_price_changed_at timestamptz;
create or replace function public.track_email_price_change() returns trigger language plpgsql set search_path=public as $$
begin
 if new.price_usd is distinct from old.price_usd or new.was_price is distinct from old.was_price then new.email_price_changed_at:=now(); end if;
 return new;
end $$;
drop trigger if exists track_email_price_change on public.products;
create trigger track_email_price_change before update on public.products for each row execute function public.track_email_price_change();
update public.products set email_price_changed_at=now() where was_price>price_usd and email_price_changed_at is null;

create table if not exists public.email_delivery_settings (
 id boolean primary key default true check(id), daily_marketing_limit integer not null default 1 check(daily_marketing_limit>0),
 weekly_marketing_limit integer not null default 3 check(weekly_marketing_limit>0), max_attempts integer not null default 6 check(max_attempts between 1 and 10)
);
insert into public.email_delivery_settings(id) values(true) on conflict do nothing;
create table if not exists public.email_suppressions(email text primary key, reason text not null, created_at timestamptz not null default now());
create table if not exists public.email_delivery_queue (
 id uuid primary key default gen_random_uuid(), dedupe_key text unique not null, recipient text, reply_to text, from_address text,
 kind text not null check(kind in ('marketing','service')), category text not null, subject text, html text, headers jsonb,
 order_id uuid references public.orders(id) on delete cascade, campaign_id uuid references public.email_campaigns(id) on delete cascade,
 status text not null default 'pending' check(status in ('pending','processing','sent','suppressed','failed')),
 attempts integer not null default 0, available_at timestamptz not null default now(), locked_at timestamptz,
 sent_at timestamptz, first_attempt_at timestamptz, last_error text, created_at timestamptz not null default now()
);
create index if not exists email_queue_pending on public.email_delivery_queue(available_at) where status in ('pending','processing');
create index if not exists email_queue_recipient on public.email_delivery_queue(lower(recipient),sent_at) where kind='marketing';
alter table public.email_delivery_settings enable row level security;
alter table public.email_suppressions enable row level security;
alter table public.email_delivery_queue enable row level security;
create policy email_queue_admin_read on public.email_delivery_queue for select to authenticated using(public.is_admin());
create policy email_delivery_settings_admin_read on public.email_delivery_settings for select to authenticated using(public.is_admin());

create or replace function public.email_marketing_allowed(p_email text) returns boolean language sql stable security definer set search_path=public as $$
 select p_email is not null and p_email !~* '@roblox\.coldd\.internal$'
 and not exists(select 1 from email_suppressions where email=lower(p_email))
 and not exists(select 1 from profiles where lower(email)=lower(p_email) and (coalesce(banned,false) or marketing_unsubscribed or notification_prefs->>'promotions'='false'))
 and (exists(select 1 from marketing_optins where lower(email)=lower(p_email) and unsubscribed_at is null)
 or exists(select 1 from profiles where lower(email)=lower(p_email) and notification_prefs->>'promotions'='true' and not marketing_unsubscribed));
$$;
revoke all on function public.email_marketing_allowed(text) from public,anon,authenticated;
grant execute on function public.email_marketing_allowed(text) to service_role;

create or replace function public.sync_profile_email_preference() returns trigger language plpgsql security definer set search_path=public as $$
declare opted boolean;
begin
 if pg_trigger_depth()>1 then return new; end if;
 if new.marketing_unsubscribed is distinct from old.marketing_unsubscribed then opted:=not new.marketing_unsubscribed;
 elsif new.notification_prefs->>'promotions' is distinct from old.notification_prefs->>'promotions' then opted:=coalesce((new.notification_prefs->>'promotions')::boolean,false);
 else return new; end if;
 new.marketing_unsubscribed:=not opted;
 new.notification_prefs:=coalesce(new.notification_prefs,'{}')||jsonb_build_object('promotions',opted);
 update marketing_optins set unsubscribed_at=case when opted then null else now() end where lower(email)=lower(new.email);
 return new;
end $$;
drop trigger if exists sync_profile_email_preference on public.profiles;
create trigger sync_profile_email_preference before update on public.profiles for each row execute function public.sync_profile_email_preference();
create or replace function public.sync_ledger_email_preference() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if pg_trigger_depth()>1 then return new; end if;
 update profiles set marketing_unsubscribed=(new.unsubscribed_at is not null), notification_prefs=coalesce(notification_prefs,'{}')||jsonb_build_object('promotions',new.unsubscribed_at is null) where lower(email)=lower(new.email);
 return new;
end $$;
drop trigger if exists sync_ledger_email_preference on public.marketing_optins;
create trigger sync_ledger_email_preference after insert or update of unsubscribed_at on public.marketing_optins for each row execute function public.sync_ledger_email_preference();

update public.profiles set notification_prefs=coalesce(notification_prefs,'{}')||'{"promotions":false}'::jsonb
 where marketing_unsubscribed and coalesce(notification_prefs->>'promotions','')<>'false';
update public.marketing_optins m set unsubscribed_at=now() where unsubscribed_at is null and exists(select 1 from profiles p where lower(p.email)=lower(m.email) and (p.marketing_unsubscribed or p.notification_prefs->>'promotions'='false'));
update public.marketing_optins set unsubscribed_at=unsubscribed_at;

create or replace function public.queue_paid_order_receipt() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.status='paid' and (tg_op='INSERT' or old.status is distinct from 'paid') then
 insert into email_delivery_queue(dedupe_key,kind,category,order_id) values('receipt/'||new.id,'service','receipt',new.id) on conflict(dedupe_key) do nothing;
 end if;
 return new;
end $$;
drop trigger if exists queue_paid_order_receipt on public.orders;
create trigger queue_paid_order_receipt after insert or update of status on public.orders for each row execute function public.queue_paid_order_receipt();

create or replace function public.claim_email_delivery(p_key text default null) returns setof public.email_delivery_queue language plpgsql security definer set search_path=public as $$
declare candidate email_delivery_queue%rowtype; settings email_delivery_settings%rowtype; claimed integer:=0;
begin
 select * into settings from email_delivery_settings where id;
 for candidate in select * from email_delivery_queue where (p_key is null or dedupe_key=p_key)
 and ((status='pending' and available_at<=now()) or (status='processing' and locked_at<now()-interval '10 minutes'))
 order by case when kind='service' then 0 else 1 end,created_at for update skip locked limit 100 loop
 if candidate.attempts>=settings.max_attempts or (candidate.first_attempt_at is not null and candidate.first_attempt_at<now()-interval '23 hours') then update email_delivery_queue set status='failed',last_error='Automatic retry window ended; review delivery before retrying' where id=candidate.id; continue; end if;
 if candidate.recipient is not null and exists(select 1 from email_suppressions where email=lower(candidate.recipient)) then
 update email_delivery_queue set status='suppressed',last_error='Address suppressed' where id=candidate.id; continue; end if;
 if candidate.kind='marketing' then
  if not email_marketing_allowed(candidate.recipient) then update email_delivery_queue set status='suppressed',last_error='Marketing preference disabled' where id=candidate.id; continue; end if;
  if candidate.created_at<now()-interval '7 days' then update email_delivery_queue set status='suppressed',last_error='Marketing message expired' where id=candidate.id; continue; end if;
  if not pg_try_advisory_xact_lock(hashtextextended(lower(candidate.recipient),0)) then continue; end if;
  if (select count(*) from email_delivery_queue where lower(recipient)=lower(candidate.recipient) and kind='marketing' and ((status='sent' and sent_at>now()-interval '24 hours') or (status='processing' and locked_at>now()-interval '10 minutes' and id<>candidate.id)))>=settings.daily_marketing_limit
  or (select count(*) from email_delivery_queue where lower(recipient)=lower(candidate.recipient) and kind='marketing' and ((status='sent' and sent_at>now()-interval '7 days') or (status='processing' and locked_at>now()-interval '10 minutes' and id<>candidate.id)))>=settings.weekly_marketing_limit then
   update email_delivery_queue set status='pending',available_at=now()+interval '30 minutes',locked_at=null where id=candidate.id; continue;
  end if;
 end if;
 update email_delivery_queue set status='processing',locked_at=now(),first_attempt_at=coalesce(first_attempt_at,now()),attempts=attempts+1 where id=candidate.id returning * into candidate;
 return next candidate; claimed:=claimed+1; if claimed>=30 then exit; end if;
 end loop;
end $$;
revoke all on function public.claim_email_delivery(text) from public,anon,authenticated;
grant execute on function public.claim_email_delivery(text) to service_role;

create or replace function public.refresh_email_campaign_delivery() returns trigger language plpgsql security definer set search_path=public as $$
declare pending_count integer; accepted_count integer; rejected_count integer;
begin
 if new.campaign_id is null then return new; end if;
 perform 1 from email_campaigns where id=new.campaign_id for update;
 select count(*) filter(where status in ('pending','processing')),count(*) filter(where status='sent'),count(*) filter(where status in ('failed','suppressed'))
 into pending_count,accepted_count,rejected_count from email_delivery_queue where campaign_id=new.campaign_id;
 update email_campaigns set sent_count=accepted_count, failed_count=rejected_count,
 status=case when pending_count>0 then 'sending' when accepted_count=0 then 'failed' else 'sent' end,
 sent_at=case when pending_count=0 then now() else null end where id=new.campaign_id;
 return new;
end $$;
create trigger refresh_email_campaign_delivery after update of status on public.email_delivery_queue for each row execute function public.refresh_email_campaign_delivery();

insert into public.email_automations(key,enabled,delay_hours,subject,body_md)
values('new_for_you',false,0,'New: {product}','A new product matches your previous purchases. Take a look below.') on conflict(key) do nothing;
update public.email_automations set subject=case key
 when 'abandoned_cart_1' then 'Your saved cart' when 'abandoned_cart_2' then 'A discount for your saved cart' when 'abandoned_cart_3' then 'Final saved-cart reminder'
 when 'post_purchase_review' then 'Review your coldd purchase' when 'reengagement' then 'Explore the latest coldd products'
 when 'wishlist_reminder' then 'A discount for your wishlist' when 'signup_nudge' then 'Explore the coldd catalogue'
 when 'wishlist_price_drop' then 'A wishlist item is on sale' when 'getting_started' then 'Download and set up your files'
 when 'resell_upgrade' then 'Upgrade your resell licence' when 'review_incentive' then '15% off your next coldd order'
 when 'repeat_buyer' then '15% off your next coldd order' when 'winback' then 'A discount for your next coldd order' else subject end,
 body_md=case key
 when 'review_incentive' then 'Use the code below for 15% off your next order. If you have a moment, leave an honest review of your purchase. The discount is yours whether or not you review.'
 when 'abandoned_cart_1' then 'Your cart is saved. Return to checkout when you are ready.'
 when 'abandoned_cart_2' then 'Your cart is saved. Use the code below at checkout.'
 when 'abandoned_cart_3' then 'This is the final reminder for this saved cart. Use your existing code if you decide to order.'
 when 'resell_upgrade' then 'You own a standard usage licence. A resell licence allows you to resell this product under your own store. View the product page for upgrade pricing.'
 else body_md end;

commit;
