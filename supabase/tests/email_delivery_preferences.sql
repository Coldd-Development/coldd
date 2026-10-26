begin;
do $$
declare claimed_count integer; profile_id uuid; profile_email text;
begin
 insert into marketing_optins(email,source,subscribed_at) values('email-audit@preview.invalid','popup',now());
 if not email_marketing_allowed('email-audit@preview.invalid') then raise exception 'Guest opt-in not eligible'; end if;
 insert into email_delivery_queue(dedupe_key,recipient,kind,category,subject,html) values
 ('audit/m1','email-audit@preview.invalid','marketing','audit','Audit','Audit'),
 ('audit/m2','email-audit@preview.invalid','marketing','audit','Audit','Audit'),
 ('audit/s1','email-audit@preview.invalid','service','audit','Audit','Audit');
 select (select count(*) from claim_email_delivery('audit/m1')) + (select count(*) from claim_email_delivery('audit/s1')) into claimed_count;
 if (select count(*) from claim_email_delivery('audit/m2'))<>0 then raise exception 'Daily marketing cap not enforced'; end if;
 if claimed_count<>2 then raise exception 'Expected 1 marketing and 1 service claim, got %',claimed_count; end if;
 update marketing_optins set unsubscribed_at=now() where email='email-audit@preview.invalid';
 if email_marketing_allowed('email-audit@preview.invalid') then raise exception 'Unsubscribe failed'; end if;
 select id,email into profile_id,profile_email from profiles where email not like '%@roblox.coldd.internal' limit 1;
 if profile_id is not null then
  update profiles set notification_prefs=coalesce(notification_prefs,'{}')||'{"promotions":true}',marketing_unsubscribed=false where id=profile_id;
  update profiles set notification_prefs=notification_prefs||'{"promotions":false}' where id=profile_id;
  if exists(select 1 from profiles where id=profile_id and not marketing_unsubscribed) then raise exception 'Promotions switch not synchronized'; end if;
  update profiles set marketing_unsubscribed=false where id=profile_id;
  if exists(select 1 from profiles where id=profile_id and notification_prefs->>'promotions'<>'true') then raise exception 'Resubscribe not synchronized'; end if;
 end if;
 if has_function_privilege('anon','public.claim_email_delivery(text)','EXECUTE') then raise exception 'Queue claim exposed'; end if;
 if has_function_privilege('authenticated','public.claim_email_delivery(text)','EXECUTE') then raise exception 'Queue claim exposed to users'; end if;
end $$;
rollback;
select 'Migration, consent sync, frequency cap, service exemption and access control passed; all rolled back' as result;
