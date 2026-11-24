-- BuiltByBit featured-resource ad fees, per purchase.
-- The creator purchases API sends AdFeePayment (the ad fee taken from that sale; 0 when the
-- sale did not come through a featured placement) and AdFeeCredit (ad credit applied to it).
-- admin-bbb-v2-sync stores both; the Analytics "External fees" panel reads them.

alter table public.bbb2_purchases
  add column if not exists ad_fee numeric,
  add column if not exists ad_fee_credit numeric;

comment on column public.bbb2_purchases.ad_fee is 'AdFeePayment.value: the featured-ad fee BuiltByBit took from this sale (USD).';
comment on column public.bbb2_purchases.ad_fee_credit is 'AdFeeCredit.value: ad credit BuiltByBit applied to this sale (USD).';
