-- The payment method a coldd.dev buyer used, as Stripe reports it on the charge (card, apple_pay,
-- google_pay, link, klarna, afterpay_clearpay, blik, bancontact, p24, pix, ...). Set by
-- stripe-webhook when the order is paid; PayPal, crypto and Robux orders keep payment_provider.
-- Read by the admin Analytics "Payment methods" panel.
alter table public.orders add column if not exists payment_method text;
