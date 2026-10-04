-- Fills marketing_optins.consent_text from `source` on every opt-in, so the
-- wording the person agreed to is recorded without touching any edge function.
create or replace function public.marketing_optins_set_consent_text()
returns trigger language plpgsql as $$
begin
  -- Keep in step with the UI strings (app.js popup, signup/checkout checkboxes).
  if new.consent_text is null or (tg_op = 'UPDATE' and new.subscribed_at is distinct from old.subscribed_at) then
    new.consent_text := case new.source
      when 'popup' then 'By continuing you agree to receive marketing emails from coldd. No spam, unsubscribe any time.'
      when 'signup' then 'Email me deals and drops (optional).'
      when 'checkout' then 'Email me deals and drops (optional).'
      else new.consent_text
    end;
  end if;
  return new;
end $$;

drop trigger if exists marketing_optins_consent_text on public.marketing_optins;
create trigger marketing_optins_consent_text
  before insert or update on public.marketing_optins
  for each row execute function public.marketing_optins_set_consent_text();
