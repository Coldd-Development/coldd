begin;
alter table public.orders add column if not exists store_credit_applied numeric not null default 0;
update public.orders o set store_credit_applied=-l.amount from public.store_credit_ledger l where l.order_id=o.id and l.kind='purchase' and o.payment_provider='store_credit';
create or replace function public.apply_store_credit(p_user_id uuid,p_order_id uuid,p_currency text,p_amount numeric default null,p_min_remainder numeric default 0) returns jsonb
language plpgsql security definer set search_path=public as $$
declare o public.orders; balance numeric; cost numeric; applied numeric; due numeric;
begin
 perform pg_advisory_xact_lock(hashtext(p_user_id::text));
 select * into o from public.orders where id=p_order_id and coalesce(purchased_by_user_id,user_id)=p_user_id for update;
 if not found or o.status<>'pending' or o.is_test then return jsonb_build_object('ok',false,'error','Order is not eligible for store credit.');end if;
 if p_currency not in ('usd','robux') or p_currency<>lower(coalesce(o.currency,'usd')) then return jsonb_build_object('ok',false,'error','Store credit must match the order currency.');end if;
 if p_amount is not null and (p_amount::text in ('NaN','Infinity','-Infinity') or p_amount<=0 or p_amount<>round(p_amount,case when p_currency='robux' then 0 else 2 end)) then return jsonb_build_object('ok',false,'error','Enter credit in USD cents or whole Robux.');end if;
 if o.store_credit_applied>0 then return jsonb_build_object('ok',true,'applied',o.store_credit_applied,'due',(case when p_currency='robux' then o.total_robux else o.total_usd end)-o.store_credit_applied,'paid',false);end if;
 select coalesce(sum(amount),0) into balance from public.store_credit_ledger where user_id=p_user_id and currency=p_currency;
 cost:=case when p_currency='robux' then o.total_robux else o.total_usd end;
 if cost is null or cost<=0 or balance<=0 then return jsonb_build_object('ok',false,'error','You have no available store credit in this currency.');end if;
 if p_amount is not null and p_amount>balance then return jsonb_build_object('ok',false,'error','The credit amount exceeds your available balance.');end if;
 applied:=least(cost,balance,coalesce(p_amount,balance));due:=cost-applied;
 if due>0 and due<p_min_remainder then applied:=greatest(0,cost-p_min_remainder);due:=cost-applied;end if;
 if applied<=0 then return jsonb_build_object('ok',false,'error','The remaining payment is below the payment provider minimum. Use less credit or cover the full order.');end if;
 insert into public.store_credit_ledger(user_id,currency,amount,order_id,kind) values(p_user_id,p_currency,-applied,o.id,'purchase');
 update public.orders set store_credit_applied=applied,credit_currency=p_currency,status=case when due=0 then 'paid' else status end,
 paid_at=case when due=0 then now() else paid_at end,payment_provider=case when due=0 then 'store_credit' else payment_provider end where id=o.id;
 return jsonb_build_object('ok',true,'applied',applied,'due',due,'paid',due=0);
end $$;
revoke all on function public.apply_store_credit(uuid,uuid,text,numeric,numeric) from public,anon,authenticated;
grant execute on function public.apply_store_credit(uuid,uuid,text,numeric,numeric) to service_role;

create or replace function public.referral_order_safety() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.stripe_checkout_session_id like 'cs_test_%' then new.is_test:=true;end if;
 if tg_op='UPDATE' then
  if new.status='paid' and old.status<>'paid' and old.status<>'pending' then raise exception 'Only pending orders can become paid';end if;
  if (old.status='paid' and new.status='refunded') or (old.status='pending' and new.status in ('canceled','failed')) or (new.status='paid' and new.is_test and old.status<>'paid') then
   insert into public.store_credit_ledger(user_id,currency,amount,order_id,kind)
   select coalesce(old.purchased_by_user_id,old.user_id),currency,-amount,old.id,'refund' from public.store_credit_ledger where order_id=old.id and kind='purchase' on conflict(order_id,kind) do nothing;
  end if;
 end if;
 return new;
end $$;

create or replace view public.referral_order_earnings as
with products_total as (
 select order_id,sum(unit_price_usd*qty) usd,sum(coalesce(unit_price_robux,unit_price_usd)*qty) robux_weight from public.order_items group by order_id
), addons_total as (
 select order_id,sum(coalesce(unit_price_robux,0)) robux from public.order_addons group by order_id
), base as (
 select o.id order_id,o.referrer_id,o.created_at,i.title product,
 case when lower(coalesce(o.currency,'usd'))='robux' then 'robux' else 'usd' end native,
 case when lower(coalesce(o.currency,'usd'))='robux' then floor(greatest(0,coalesce(o.total_robux,0)-coalesce(a.robux,0))*coalesce(i.unit_price_robux,i.unit_price_usd)*i.qty/nullif(t.robux_weight,0)*0.20)
 else round(i.unit_price_usd*i.qty*greatest(0,1-coalesce(o.discount_usd,0)/nullif(t.usd,0))*0.20,2) end commission,
 case when o.payment_provider='store_credit' then 1 else least(1,greatest(0,o.store_credit_applied/nullif(case when lower(coalesce(o.currency,'usd'))='robux' then o.total_robux else o.total_usd end,0))) end credit_ratio
 from public.orders o join public.order_items i on i.order_id=o.id and i.product_slug=o.ref_product_slug join products_total t on t.order_id=o.id left join addons_total a on a.order_id=o.id
 where o.status='paid' and not o.is_test and o.referrer_id is not null and o.referrer_id is distinct from coalesce(o.purchased_by_user_id,o.user_id)
 and (auth.role()='service_role' or auth.uid()=o.referrer_id or exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_admin))
), split as (
 select *,case when native='robux' then floor(commission*(1-credit_ratio)) else round(commission*(1-credit_ratio),2) end cash_commission from base
)
select order_id,referrer_id,created_at,product,native currency,cash_commission amount from split where credit_ratio<1
union all
select order_id,referrer_id,created_at,product,'store_'||native currency,commission-cash_commission amount from split where credit_ratio>0;

create or replace function public.store_credit_balances(p_user_id uuid) returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('usd',coalesce(sum(amount) filter(where currency='usd'),0),'robux',coalesce(sum(amount) filter(where currency='robux'),0)) from public.store_credit_ledger where user_id=p_user_id;
$$;
revoke all on function public.store_credit_balances(uuid) from public,anon,authenticated;
grant execute on function public.store_credit_balances(uuid) to service_role;

create or replace function public.expire_robux_credit_holds() returns void language sql security definer set search_path=public as $$
 update public.orders set status='canceled' where status='pending' and lower(currency)='robux' and store_credit_applied>0 and created_at<now()-interval '30 minutes';
$$;
revoke all on function public.expire_robux_credit_holds() from public,anon,authenticated;
select cron.schedule('expire-robux-credit-holds','*/5 * * * *','select public.expire_robux_credit_holds()');
commit;