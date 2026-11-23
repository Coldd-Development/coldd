-- BuiltByBit sync (2026-11-24): a Retry-After cooldown outlives the run that got it,
-- so the next cron run (every 2 minutes) also waits until BuiltByBit said it may call again.
alter table public.bbb2_state add column if not exists cooldown_until timestamptz;
