-- Run this once in Supabase Dashboard -> SQL Editor. Safe to re-run
-- (idempotent - just replaces the function).
--
-- request-referral-payout computes "available balance" (earned minus
-- already-requested) and does the INSERT in one atomic call - see the
-- original comment history for why (a check-then-act race between two
-- concurrent requests).
--
-- Rewritten for per-product-only referrals: earnings are always USD-
-- denominated (20% of the matching order_items row on an order the
-- caller referred - see _shared/referrals.ts), there is no separate
-- Robux-currency earning pool anymore. A 'robux' payout request is still
-- accepted (the admin fulfills it manually in Robux), but the amount
-- typed is Robux units converted to its USD-equivalent at ROBUX_PER_USD
-- (matches app.js/admin.js/_shared/roblox.ts) purely so every payout
-- request - regardless of method - debits the same single USD balance.

create or replace function public.request_referral_payout(
  p_user_id uuid,
  p_method text,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  earned_usd numeric := 0;
  reserved_usd numeric := 0;
  available_usd numeric;
  requested_usd numeric;
  referral_rate constant numeric := 0.20;
  robux_per_usd constant numeric := 80;
begin
  if p_method not in ('usd', 'robux', 'store_credit') then
    return jsonb_build_object('ok', false, 'error', 'Invalid payout method.');
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Enter an amount.');
  end if;

  -- Serialize concurrent calls for this same user for the rest of this
  -- transaction - hashtext() collapses the uuid into an int4 lock key.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select coalesce(sum(oi.unit_price_usd * oi.qty * referral_rate), 0)
  into earned_usd
  from public.orders o
  join public.order_items oi on oi.order_id = o.id and oi.product_slug = o.ref_product_slug
  where o.referrer_id = p_user_id and o.status = 'paid';

  select coalesce(sum(amount_usd), 0)
  into reserved_usd
  from public.referral_payouts
  where user_id = p_user_id and status <> 'denied';

  available_usd := greatest(0, earned_usd - reserved_usd);
  requested_usd := case when p_method = 'robux' then round(p_amount / robux_per_usd, 2) else p_amount end;

  if requested_usd > available_usd then
    return jsonb_build_object('ok', false, 'error', 'Amount exceeds your available balance.');
  end if;

  if p_method = 'robux' then
    insert into public.referral_payouts (user_id, method, status, amount_usd, amount_robux)
    values (p_user_id, p_method, 'requested', requested_usd, round(p_amount));
  else
    insert into public.referral_payouts (user_id, method, status, amount_usd)
    values (p_user_id, p_method, 'requested', requested_usd);
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.request_referral_payout(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.request_referral_payout(uuid, text, numeric) to service_role;
