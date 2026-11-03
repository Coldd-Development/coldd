-- Store credit can now be put toward PayPal and crypto orders too. The credit is reserved when the
-- order is created; if the buyer never pays, the order is canceled here and the
-- referral_order_safety trigger returns the credit. The windows are generous so a slow PayPal
-- approval or a crypto payment still confirming is never canceled under the buyer.
begin;
create or replace function public.expire_credit_holds() returns void language sql security definer set search_path=public as $$
 update public.orders set status='canceled'
 where status='pending' and store_credit_applied>0 and lower(coalesce(currency,'usd'))='usd'
   and ((paypal_order_id is not null and created_at<now()-interval '6 hours')
     or (crypto_charge_id is not null and created_at<now()-interval '24 hours'));
$$;
revoke all on function public.expire_credit_holds() from public,anon,authenticated;
select cron.schedule('expire-credit-holds','*/15 * * * *','select public.expire_credit_holds()');
commit;
