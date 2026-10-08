-- Marketplace to-do list: "site" becomes a valid target, and finished tasks record who finished them.
alter table public.marketplace_tasks drop constraint if exists marketplace_tasks_marketplace_check;
alter table public.marketplace_tasks
  add constraint marketplace_tasks_marketplace_check
  check (marketplace = any (array['builtbybit','clearlydev','parcel','creatorstore','site']));

alter table public.marketplace_tasks add column if not exists done_by uuid references public.profiles(id) on delete set null;
alter table public.marketplace_tasks add column if not exists done_by_name text;
