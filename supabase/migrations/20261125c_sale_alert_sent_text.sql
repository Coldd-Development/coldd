-- Sale alerts (2026-11-25): keep the exact title and text each alert was sent with
-- (amounts are converted to AU$ when sent), so the admin's Recent alerts shows what
-- the phone showed.
alter table public.sale_alerts add column if not exists sent_title text;
alter table public.sale_alerts add column if not exists sent_body text;
