-- Run this once in Supabase Dashboard -> SQL Editor.
--
-- IMPORTANT: replace REPLACE_WITH_FILE_AUDIT_CRON_SECRET below with the same value you set via:
--   supabase secrets set FILE_AUDIT_CRON_SECRET=<some random string>
-- Never commit the real secret value into this file - it's checked into git.
--
-- Schedules cron-file-audit once a day: it checks that every product, add-on and legal file
-- is really in storage, re-links legal files the upload ledger can recover, and sends the
-- admins a bell notification about anything still wrong.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'cron-file-audit',
  '40 4 * * *',
  $$
  select net.http_post(
    url := 'https://ekinmytmudjwfaqaqswp.supabase.co/functions/v1/cron-file-audit',
    headers := jsonb_build_object('x-cron-secret', 'REPLACE_WITH_FILE_AUDIT_CRON_SECRET', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- To remove/replace the schedule later:
--   select cron.unschedule('cron-file-audit');
