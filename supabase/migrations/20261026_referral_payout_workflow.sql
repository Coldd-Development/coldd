begin;

alter table public.orders add column if not exists is_test boolean not null default false;
alter table public.orders add column if not exists credit_currency text;
update public.orders set is_test=true where stripe_checkout_session_id like 'cs_test_%';
alter table public.order_items add column if not exists unit_price_robux numeric;
alter table public.referral_payouts add column if not exists source_currency text not null default 'usd';
alter table public.referral_payouts add column if not exists paypal_email text;
alter table public.referral_payouts add column if not exists gamepass_url text;
alter table public.referral_payouts add column if not exists change_reason text;
alter table public.referral_payouts add column if not exists transfer_reference text;
alter table public.referral_payouts add column if not exists reviewed_by uuid references auth.users(id);
alter table public.referral_payouts add column if not exists updated_at timestamptz not null default now();
alter table public.referral_payouts add column if not exists revision integer not null default 1;
alter table public.referral_payouts add column if not exists idempotency_key uuid;
alter table public.referral_payouts add column if not exists is_test boolean not null default false;
alter table public.referral_payouts drop constraint if exists referral_payouts_status_check;
alter table public.referral_payouts add constraint referral_payouts_status_check check(status in ('requested','changes_requested','paid','denied'));
create unique index if not exists referral_payout_idempotency on public.referral_payouts(user_id,idempotency_key) where idempotency_key is not null;

create table if not exists public.referral_payment_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  paypal_email text,
  gamepass_url text,
  updated_at timestamptz not null default now()
);
alter table public.referral_payment_details enable row level security;
create policy referral_payment_details_read on public.referral_payment_details for select to authenticated using(user_id=auth.uid());
grant select on public.referral_payment_details to authenticated;

create table if not exists public.store_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  currency text not null check(currency in ('usd','robux')),
  amount numeric not null,
  payout_id uuid references public.referral_payouts(id),
  order_id uuid references public.orders(id),
  kind text not null check(kind in ('payout','purchase','refund')),
  created_at timestamptz not null default now(),
  unique(payout_id,kind),
  unique(order_id,kind)
);
alter table public.store_credit_ledger enable row level security;
create policy store_credit_read on public.store_credit_ledger for select to authenticated using(user_id=auth.uid());
grant select on public.store_credit_ledger to authenticated;

create or replace view public.referral_order_earnings as
with products_total as (
  select order_id,sum(unit_price_usd*qty) usd,sum(coalesce(unit_price_robux,unit_price_usd)*qty) robux_weight
  from public.order_items group by order_id
), addons_total as (
  select order_id,sum(coalesce(unit_price_robux,0)) robux from public.order_addons group by order_id
)
select o.id order_id,o.referrer_id,o.created_at,i.title product,
  case when o.payment_provider='store_credit' then 'store_'||coalesce(o.credit_currency,'usd')
       when lower(coalesce(o.currency,'usd'))='robux' then 'robux' else 'usd' end currency,
  case when lower(coalesce(o.currency,'usd'))='robux' then
    floor(greatest(0,coalesce(o.total_robux,0)-coalesce(a.robux,0))*
      coalesce(i.unit_price_robux,i.unit_price_usd)*i.qty/nullif(t.robux_weight,0)*0.20)
  else round(i.unit_price_usd*i.qty*greatest(0,1-coalesce(o.discount_usd,0)/nullif(t.usd,0))*0.20,2) end amount
from public.orders o join public.order_items i on i.order_id=o.id and i.product_slug=o.ref_product_slug
join products_total t on t.order_id=o.id left join addons_total a on a.order_id=o.id
where o.status='paid' and not o.is_test and o.referrer_id is not null
  and o.referrer_id is distinct from coalesce(o.purchased_by_user_id,o.user_id)
  and (auth.role()='service_role' or auth.uid()=o.referrer_id or exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_admin));
grant select on public.referral_order_earnings to authenticated,service_role;

create or replace function public.referral_balances(p_user_id uuid) returns jsonb
language sql stable security definer set search_path=public as $$
select jsonb_object_agg(k,jsonb_build_object('earned',earned,'reserved',reserved,'paid',paid,
  'available',greatest(0,earned-reserved),'debt',greatest(0,reserved-earned))) from (
select k,coalesce((select sum(amount) from public.referral_order_earnings where referrer_id=p_user_id and currency=k),0) earned,
 coalesce((select sum(case when k in ('robux','store_robux') then amount_robux else amount_usd end) from public.referral_payouts
  where user_id=p_user_id and source_currency=k and status<>'denied' and not is_test),0) reserved,
 coalesce((select sum(case when k in ('robux','store_robux') then amount_robux else amount_usd end) from public.referral_payouts
  where user_id=p_user_id and source_currency=k and status='paid' and not is_test),0) paid
from unnest(array['usd','robux','store_usd','store_robux']) k) b;
$$;
revoke all on function public.referral_balances(uuid) from public,anon,authenticated;
grant execute on function public.referral_balances(uuid) to service_role;

drop function if exists public.request_referral_payout(uuid,text,numeric);
create or replace function public.request_referral_payout(p_user_id uuid,p_method text,p_amount numeric,
  p_source text,p_paypal text default null,p_gamepass text default null,p_key uuid default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare b jsonb; p public.referral_payouts; native_robux boolean;
begin
 perform pg_advisory_xact_lock(hashtext(p_user_id::text));
 if p_key is not null then
   select * into p from public.referral_payouts where user_id=p_user_id and idempotency_key=p_key;
   if found then return jsonb_build_object('ok',true,'id',p.id); end if;
 end if;
 if p_source not in ('usd','robux','store_usd','store_robux') or p_method not in ('usd','robux','store_credit')
   or (p_method='usd' and p_source<>'usd') or (p_method='robux' and p_source<>'robux') then
   return jsonb_build_object('ok',false,'error','Choose a payout method available for this earnings currency.'); end if;
 native_robux:=p_source in ('robux','store_robux');
 if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') or p_amount<=0 or p_amount<>round(p_amount,case when native_robux then 0 else 2 end) then
   return jsonb_build_object('ok',false,'error','Enter a positive amount in whole Robux or USD cents.'); end if;
 if p_method='usd' and (p_paypal is null or length(p_paypal)>254 or p_paypal !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
   return jsonb_build_object('ok',false,'error','Add your PayPal payout email.'); end if;
 if p_method='robux' and (p_gamepass is null or p_gamepass !~ '^https://www\.roblox\.com/game-pass/[0-9]+/?$') then
   return jsonb_build_object('ok',false,'error','Add a valid Roblox gamepass link.'); end if;
 b:=public.referral_balances(p_user_id);
 if p_amount>coalesce((b->p_source->>'available')::numeric,0) then return jsonb_build_object('ok',false,'error','Amount exceeds your available balance.'); end if;
 insert into public.referral_payment_details(user_id,paypal_email,gamepass_url) values(p_user_id,p_paypal,p_gamepass)
 on conflict(user_id) do update set paypal_email=coalesce(excluded.paypal_email,referral_payment_details.paypal_email),
 gamepass_url=coalesce(excluded.gamepass_url,referral_payment_details.gamepass_url),updated_at=now();
 insert into public.referral_payouts(user_id,method,source_currency,amount_usd,amount_robux,status,paypal_email,gamepass_url,idempotency_key)
 values(p_user_id,p_method,p_source,case when native_robux then 0 else p_amount end,case when native_robux then p_amount else null end,'requested',
 case when p_method='usd' then p_paypal end,case when p_method='robux' then p_gamepass end,p_key) returning * into p;
 return jsonb_build_object('ok',true,'id',p.id);
end;
$$;
revoke all on function public.request_referral_payout(uuid,text,numeric,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.request_referral_payout(uuid,text,numeric,text,text,text,uuid) to service_role;

create or replace function public.manage_referral_payout(p_actor uuid,p_id uuid,p_action text,p_note text default null,p_reference text default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare p public.referral_payouts; b jsonb; total_reserved numeric; earned numeric; credit_currency text;
begin
 if not exists(select 1 from public.profiles where id=p_actor and is_admin) then return jsonb_build_object('ok',false,'error','Admin access required.'); end if;
 select * into p from public.referral_payouts where id=p_id;
 if not found then return jsonb_build_object('ok',false,'error','Payout not found.'); end if;
 perform pg_advisory_xact_lock(hashtext(p.user_id::text));
 select * into p from public.referral_payouts where id=p_id for update;
 if p.status not in ('requested','changes_requested') then return jsonb_build_object('ok',false,'error','This payout has already been resolved. Refresh the page.'); end if;
 if p_action not in ('mark_paid','deny','request_changes') or (p_action='request_changes' and coalesce(length(trim(p_note)),0)<5) then
   return jsonb_build_object('ok',false,'error','Explain which payment details need correcting.'); end if;
 if p_action='mark_paid' then
   if p.status<>'requested' then return jsonb_build_object('ok',false,'error','Wait for the corrected payment details before paying.'); end if;
   if not p.is_test then
    b:=public.referral_balances(p.user_id);
    earned:=(b->p.source_currency->>'earned')::numeric;
    total_reserved:=(b->p.source_currency->>'reserved')::numeric;
    if total_reserved>earned then return jsonb_build_object('ok',false,'error','Earnings no longer cover the reserved payouts. Review refunded orders and deny excess requests first.'); end if;
   end if;
   if p.method='usd' and p.paypal_email is null or p.method='robux' and p.gamepass_url is null then
    return jsonb_build_object('ok',false,'error','Request the missing payment details first.'); end if;
   if p.method<>'store_credit' and coalesce(length(trim(p_reference)),0)<3 then return jsonb_build_object('ok',false,'error','Enter the payment transaction reference.'); end if;
   if p.method='store_credit' and not p.is_test then
    credit_currency:=case when p.source_currency in ('robux','store_robux') then 'robux' else 'usd' end;
    insert into public.store_credit_ledger(user_id,currency,amount,payout_id,kind)
    values(p.user_id,credit_currency,case when credit_currency='robux' then p.amount_robux else p.amount_usd end,p.id,'payout');
   end if;
 end if;
 update public.referral_payouts set status=case p_action when 'mark_paid' then 'paid' when 'deny' then 'denied' else 'changes_requested' end,
 note=nullif(left(trim(p_note),500),''),change_reason=case when p_action='request_changes' then left(trim(p_note),500) else null end,
 transfer_reference=case when p_action='mark_paid' then nullif(left(trim(p_reference),200),'') else null end,
 reviewed_by=p_actor,resolved_at=case when p_action='request_changes' then null else now() end,updated_at=now(),revision=revision+1 where id=p.id;
 return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.manage_referral_payout(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.manage_referral_payout(uuid,uuid,text,text,text) to service_role;

create or replace function public.revise_referral_payout(p_user_id uuid,p_id uuid,p_paypal text,p_gamepass text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare p public.referral_payouts;
begin
 perform pg_advisory_xact_lock(hashtext(p_user_id::text));
 select * into p from public.referral_payouts where id=p_id and user_id=p_user_id for update;
 if not found or p.status<>'changes_requested' then return jsonb_build_object('ok',false,'error','This request is not awaiting changes. Refresh the page.'); end if;
 if p.method='usd' and (p_paypal is null or length(p_paypal)>254 or p_paypal !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
   return jsonb_build_object('ok',false,'error','Enter a valid PayPal email.'); end if;
 if p.method='robux' and (p_gamepass is null or p_gamepass !~ '^https://www\.roblox\.com/game-pass/[0-9]+/?$') then
   return jsonb_build_object('ok',false,'error','Enter a valid Roblox gamepass link.'); end if;
 update public.referral_payouts set paypal_email=case when method='usd' then p_paypal else paypal_email end,
 gamepass_url=case when method='robux' then p_gamepass else gamepass_url end,status='requested',change_reason=null,
 updated_at=now(),revision=revision+1 where id=p_id;
 insert into public.referral_payment_details(user_id,paypal_email,gamepass_url) values(p_user_id,p_paypal,p_gamepass)
 on conflict(user_id) do update set paypal_email=coalesce(excluded.paypal_email,referral_payment_details.paypal_email),
 gamepass_url=coalesce(excluded.gamepass_url,referral_payment_details.gamepass_url),updated_at=now();
 return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.revise_referral_payout(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.revise_referral_payout(uuid,uuid,text,text) to service_role;

create table if not exists public.referral_email_outbox (
 id uuid primary key default gen_random_uuid(),payout_id uuid not null references public.referral_payouts(id) on delete cascade,
 revision integer not null,recipient text not null,subject text not null,body text not null,
 created_at timestamptz not null default now(),sent_at timestamptz,claimed_at timestamptz,attempts integer not null default 0,last_error text,
 unique(payout_id,revision,recipient)
);
alter table public.referral_email_outbox enable row level security;

create or replace function public.queue_referral_message() returns trigger
language plpgsql security definer set search_path=public as $$
declare heading text; message text; amount_text text; recipient_email text; event_name text;
begin
 if new.is_test then return new; end if;
 if tg_op='UPDATE' and new.revision=old.revision then return new; end if;
 amount_text:=case when new.source_currency in ('robux','store_robux') then 'R$ '||new.amount_robux else '$'||to_char(new.amount_usd,'FM999999990.00')||' USD' end;
 event_name:=case when new.status='requested' and tg_op='UPDATE' then 'updated' else new.status end;
 heading:=case event_name when 'requested' then 'Payout request received' when 'updated' then 'Payout details updated'
 when 'changes_requested' then 'Your payout needs updated details' when 'paid' then 'Payout completed' else 'Payout request denied' end;
 message:=amount_text||' via '||case new.method when 'usd' then 'PayPal' when 'robux' then 'Robux gamepass' else 'store credit' end||'. '||
 case event_name when 'requested' then 'We usually fulfill payout requests in around 72 hours. We will email you if we need any changes.'
 when 'updated' then 'Your corrected details are back with our team. Allow around 72 hours from resubmission for review and fulfillment.'
 when 'changes_requested' then coalesce(new.change_reason,'Please update your payment details.')||' Open Referrals in your dashboard and choose Update details. Your amount stays reserved.'
 when 'paid' then case when new.method='store_credit' then 'Your store credit is ready to use in the same currency at checkout.' else 'Our team has recorded your manual payment. Reference: '||coalesce(new.transfer_reference,'Contact support')||'. Provider processing times may apply.' end
 else coalesce(new.note,'Our team could not approve this request.')||' Your reserved earnings are available again, subject to refunds.' end;
 select email into recipient_email from public.profiles where id=new.user_id;
 if recipient_email is not null then insert into public.referral_email_outbox(payout_id,revision,recipient,subject,body)
 values(new.id,new.revision,recipient_email,heading,message) on conflict do nothing; end if;
 if event_name in ('requested','updated') then
  insert into public.referral_email_outbox(payout_id,revision,recipient,subject,body)
  select new.id,new.revision,email,'Admin: '||heading,message||' Review this request in Admin > Marketing > Referral payout requests.'
  from public.profiles where is_admin and email is not null and email is distinct from recipient_email on conflict do nothing;
 end if;
 insert into public.notifications(user_id,title,body,url) values(new.user_id,heading,message,'/dashboard?panel=referrals');
 return new;
end;
$$;
drop trigger if exists referral_payout_message on public.referral_payouts;
create trigger referral_payout_message after insert or update on public.referral_payouts for each row execute function public.queue_referral_message();

create or replace function public.claim_referral_emails() returns setof public.referral_email_outbox
language sql security definer set search_path=public as $$
 update public.referral_email_outbox set claimed_at=now(),attempts=attempts+1 where id in
 (select id from public.referral_email_outbox where sent_at is null and (claimed_at is null or claimed_at<now()-interval '5 minutes')
 and attempts<20 order by created_at for update skip locked limit 20) returning *;
$$;
revoke all on function public.claim_referral_emails() from public,anon,authenticated;
grant execute on function public.claim_referral_emails() to service_role;

create or replace function public.spend_store_credit(p_user_id uuid,p_order_id uuid,p_currency text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o public.orders; credit numeric; cost numeric;
begin
 perform pg_advisory_xact_lock(hashtext(p_user_id::text));
 select * into o from public.orders where id=p_order_id and coalesce(purchased_by_user_id,user_id)=p_user_id for update;
 if not found or o.status<>'pending' or o.is_test then return jsonb_build_object('ok',false,'error','Order is not eligible for store credit.'); end if;
 if p_currency not in ('usd','robux') or p_currency<>lower(coalesce(o.currency,'usd')) then return jsonb_build_object('ok',false,'error','Store credit must match the order currency.'); end if;
 select coalesce(sum(amount),0) into credit from public.store_credit_ledger where user_id=p_user_id and currency=p_currency;
 cost:=case when p_currency='robux' then o.total_robux else o.total_usd end;
 if cost is null or cost<=0 or credit<cost then return jsonb_build_object('ok',false,'error','Your store credit does not cover this order. Choose another payment method or reduce your cart.'); end if;
 insert into public.store_credit_ledger(user_id,currency,amount,order_id,kind) values(p_user_id,p_currency,-cost,o.id,'purchase');
 update public.orders set status='paid',paid_at=now(),payment_provider='store_credit',credit_currency=p_currency where id=o.id;
 return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.spend_store_credit(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.spend_store_credit(uuid,uuid,text) to service_role;

create or replace function public.referral_order_safety() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.stripe_checkout_session_id like 'cs_test_%' then new.is_test:=true; end if;
 if tg_op='UPDATE' and old.status='paid' and new.status='refunded' and old.payment_provider='store_credit' then
  insert into public.store_credit_ledger(user_id,currency,amount,order_id,kind)
  select coalesce(old.purchased_by_user_id,old.user_id),currency,-amount,old.id,'refund'
  from public.store_credit_ledger where order_id=old.id and kind='purchase' on conflict(order_id,kind) do nothing;
 end if;
 return new;
end;
$$;
drop trigger if exists referral_order_safety on public.orders;
create trigger referral_order_safety before insert or update on public.orders for each row execute function public.referral_order_safety();

commit;
