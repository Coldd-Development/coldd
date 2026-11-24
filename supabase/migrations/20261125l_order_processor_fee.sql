-- The payment processor's actual fee on a coldd.dev order, as the processor reports it:
-- Stripe's balance-transaction fee (stripe-webhook) or PayPal's paypal_fee on the capture
-- (capture-paypal-order), in that fee's own currency. Read by Analytics "External fees".
alter table public.orders
  add column if not exists processor_fee numeric,
  add column if not exists processor_fee_currency text;
