-- BuiltByBit sync every minute (2026-11-24): a run holds this lock while it works, so
-- an overlapping run skips and BuiltByBit only ever sees one stream of requests.
alter table public.bbb2_state add column if not exists running_until timestamptz;
