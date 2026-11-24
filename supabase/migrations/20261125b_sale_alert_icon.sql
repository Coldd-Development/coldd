-- Sale alerts (2026-11-25): the alert icon's link lives in the settings, so changing it
-- needs no redeploy. Bark caches an icon by its link and downloads it once, so a new icon
-- must get a new link (sale-alert-v2.png, -v3 ...), never replace the file at the old one.
alter table public.sale_alert_settings
  add column if not exists icon_url text not null default 'https://coldd.dev/mp-logos/sale-alert-v2.png';
update public.sale_alert_settings set icon_url = 'https://coldd.dev/mp-logos/sale-alert-v2.png' where id;
