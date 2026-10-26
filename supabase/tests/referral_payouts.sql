begin;
set local request.jwt.claim.role='service_role';
DO $$
declare
 u uuid:=(select id from public.profiles where is_admin order by id limit 1);
 prod uuid; o1 uuid:=gen_random_uuid();o2 uuid:=gen_random_uuid();o3 uuid:=gen_random_uuid();ot uuid:=gen_random_uuid();oc uuid:=gen_random_uuid();
 r jsonb;b jsonb;pay uuid;robpay uuid;cpay uuid;key uuid:=gen_random_uuid();n numeric;before_credit numeric;
begin
 select id into strict prod from public.products where slug='japanese-anime-asset-pack';
 insert into public.orders(id,status,currency,subtotal_usd,discount_usd,total_usd,referrer_id,ref_product_slug)
 values(o1,'paid','usd',4.99,0,4.99,u,'japanese-anime-asset-pack'),(o3,'paid','usd',20,10,10,u,'japanese-anime-asset-pack');
 insert into public.order_items(order_id,product_id,product_slug,title,unit_price_usd,qty,licence)
 values(o1,prod,'japanese-anime-asset-pack','Referral test',4.99,1,'standard'),
 (o3,prod,'japanese-anime-asset-pack','Discounted referral',10,1,'standard'),(o3,prod,'unrelated-test-product','Unrelated',10,1,'standard');
 if(select amount from public.referral_order_earnings where order_id=o1)<>1 then raise exception 'USD cent rounding failed';end if;
 if(select amount from public.referral_order_earnings where order_id=o3)<>1 then raise exception 'Discount allocation failed';end if;
 r:=public.request_referral_payout(u,'usd',1,'usd','codex-test@example.invalid',null,key);
 if not(r->>'ok')::boolean then raise exception 'Full rounded earning request failed: %',r;end if;pay:=(r->>'id')::uuid;
 r:=public.request_referral_payout(u,'usd',1,'usd','codex-test@example.invalid',null,key);
 if(r->>'id')::uuid<>pay then raise exception 'Duplicate request created another payout';end if;
 b:=public.referral_balances(u);
 r:=public.request_referral_payout(u,'usd',(b->'usd'->>'available')::numeric+1,'usd','codex-test@example.invalid');
 if(r->>'ok')::boolean then raise exception 'Overspend accepted';end if;
 r:=public.request_referral_payout(u,'robux',1,'usd',null,'https://www.roblox.com/game-pass/123');
 if(r->>'ok')::boolean then raise exception 'Cross-currency payout accepted';end if;
 r:=public.request_referral_payout(u,'usd',0.1,'usd','bad-email');
 if(r->>'ok')::boolean then raise exception 'Invalid email accepted';end if;
 insert into public.orders(id,status,currency,subtotal_usd,total_usd,total_robux,referrer_id,ref_product_slug)
 values(o2,'paid','robux',20,10,1000,u,'japanese-anime-asset-pack');
 insert into public.order_items(order_id,product_id,product_slug,title,unit_price_usd,unit_price_robux,qty,licence)
 values(o2,prod,'japanese-anime-asset-pack','Robux referral',5,500,1,'standard'),(o2,prod,'unrelated-test-product','Other Robux item',15,1500,1,'standard');
 if(select amount from public.referral_order_earnings where order_id=o2)<>50 then raise exception 'Robux discounted line allocation failed';end if;
 r:=public.request_referral_payout(u,'robux',1.5,'robux',null,'https://www.roblox.com/game-pass/123');
 if(r->>'ok')::boolean then raise exception 'Fractional Robux accepted';end if;
 r:=public.request_referral_payout(u,'robux',20,'robux',null,'https://evil.example/game-pass/123');
 if(r->>'ok')::boolean then raise exception 'Invalid gamepass host accepted';end if;
 r:=public.request_referral_payout(u,'robux',20,'robux',null,'https://www.roblox.com/game-pass/123');
 if not(r->>'ok')::boolean then raise exception 'Native Robux payout failed: %',r;end if;robpay:=(r->>'id')::uuid;
 insert into public.orders(id,status,currency,subtotal_usd,total_usd,referrer_id,ref_product_slug,stripe_checkout_session_id)
 values(ot,'paid','usd',100,100,u,'japanese-anime-asset-pack','cs_test_referral_regression');
 insert into public.order_items(order_id,product_id,product_slug,title,unit_price_usd,qty,licence)
 values(ot,prod,'japanese-anime-asset-pack','Sandbox excluded',100,1,'standard');
 if exists(select 1 from public.referral_order_earnings where order_id=ot) then raise exception 'Sandbox earnings leaked';end if;
 r:=public.manage_referral_payout(u,pay,'request_changes','Please correct the PayPal email.');
 if not(r->>'ok')::boolean then raise exception 'Request changes failed';end if;
 r:=public.manage_referral_payout(u,pay,'mark_paid',null,'test-reference');
 if(r->>'ok')::boolean then raise exception 'Changes-requested payout completed';end if;
 r:=public.revise_referral_payout(gen_random_uuid(),pay,'other@example.invalid',null);
 if(r->>'ok')::boolean then raise exception 'Another user revised payout';end if;
 r:=public.revise_referral_payout(u,pay,'corrected@example.invalid',null);
 if not(r->>'ok')::boolean then raise exception 'Correction resubmit failed';end if;
 r:=public.manage_referral_payout(u,pay,'mark_paid',null,'test-reference');
 if not(r->>'ok')::boolean then raise exception 'Paid transition failed: %',r;end if;
 r:=public.manage_referral_payout(u,pay,'deny','Duplicate stale action');
 if(r->>'ok')::boolean then raise exception 'Paid payout was reopened';end if;
 r:=public.manage_referral_payout(u,robpay,'deny','Regression test only');
 if not(r->>'ok')::boolean then raise exception 'Deny failed';end if;
 r:=public.request_referral_payout(u,'store_credit',0.5,'usd');
 if not(r->>'ok')::boolean then raise exception 'USD to store credit failed: %',r;end if;cpay:=(r->>'id')::uuid;
 select coalesce(sum(amount),0) into before_credit from public.store_credit_ledger where user_id=u and currency='usd';
 r:=public.manage_referral_payout(u,cpay,'mark_paid');
 if not(r->>'ok')::boolean then raise exception 'Store-credit issuance failed: %',r;end if;
 select coalesce(sum(amount),0) into n from public.store_credit_ledger where user_id=u and currency='usd';
 if n<>before_credit+0.5 then raise exception 'Store credit not credited';end if;
 insert into public.orders(id,user_id,status,currency,subtotal_usd,total_usd) values(oc,u,'pending','usd',0.5,0.5);
 r:=public.spend_store_credit(u,oc,'robux');if(r->>'ok')::boolean then raise exception 'Cross-currency credit spent';end if;
 r:=public.spend_store_credit(u,oc,'usd');if not(r->>'ok')::boolean then raise exception 'Store credit redemption failed: %',r;end if;
 r:=public.spend_store_credit(u,oc,'usd');if(r->>'ok')::boolean then raise exception 'Double credit redemption accepted';end if;
 update public.orders set status='refunded' where id=oc;
 if(select count(*) from public.store_credit_ledger where order_id=oc and kind='refund')<>1 then raise exception 'Store credit refund not restored';end if;
 update public.orders set status='refunded' where id=o1;
 if exists(select 1 from public.referral_order_earnings where order_id=o1) then raise exception 'Refunded commission retained';end if;
 if not exists(select 1 from public.referral_email_outbox where payout_id=pay and body like '%72 hours%') then raise exception '72-hour email missing';end if;
 if not exists(select 1 from public.referral_email_outbox where payout_id=pay and subject='Your payout needs updated details') then raise exception 'Changes email missing';end if;
 if not exists(select 1 from public.referral_email_outbox where payout_id=pay and subject='Payout completed') then raise exception 'Completion email missing';end if;
 if not exists(select 1 from public.referral_email_outbox where payout_id=robpay and subject='Payout request denied') then raise exception 'Denied email missing';end if;
end;
$$;
ROLLBACK;
SELECT 'PASS: currency, discounts, rounding, sandbox exclusion, duplicate requests, corrections, terminal states, store credit redemption/refund and transactional emails; all fixtures rolled back' as result;
