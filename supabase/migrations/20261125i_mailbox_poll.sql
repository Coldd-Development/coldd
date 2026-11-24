-- mailbox-poll: reads the coldd.dev mailboxes (Migadu IMAP) every 10 minutes.
--   * vendor receipt / invoice emails -> stored in the private finance-receipts bucket and
--     attached to the matching bank expense; ones with no expense yet wait in
--     finance_receipt_inbox and are matched on later runs.
--   * new mail to support@, legal@ and marketing@ -> a task in admin_todos.
-- Passwords live in Supabase secrets MAILBOX_<NAME> (scripts/set-mailbox-secrets.cjs), never here.

-- Emailed receipts (owner only, like every finance table).
create table if not exists public.finance_receipt_inbox (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,
  account text not null,
  sent_at timestamptz,
  mail_from text,
  subject text,
  vendor text,
  amounts numeric[] not null default '{}',
  status text not null check (status in ('attached', 'waiting', 'unmatched', 'already', 'ignored', 'failed')),
  expense_id uuid references public.finance_expenses(id) on delete set null,
  files jsonb not null default '[]'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists finance_receipt_inbox_status_idx on public.finance_receipt_inbox (status, sent_at desc);
alter table public.finance_receipt_inbox enable row level security;
do $$ begin
  create policy finance_owner_only on public.finance_receipt_inbox
    for all using ((select public.finance_allowed())) with check ((select public.finance_allowed()));
exception when duplicate_object then null;
end $$;

-- Where each mailbox got to (no passwords). Admins can read it to see a failed login.
create table if not exists public.mailbox_poll_state (
  account text primary key,
  uidvalidity bigint,
  last_uid bigint,
  backfill_uid bigint,
  backfill_done boolean not null default false,
  login_ok boolean,
  last_error text,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.mailbox_poll_state enable row level security;
do $$ begin
  create policy mailbox_poll_state_admin_read on public.mailbox_poll_state for select using (public.is_admin());
exception when duplicate_object then null;
end $$;

-- Email tasks in Today's work.
alter table public.admin_todos
  add column if not exists kind text,
  add column if not exists label text,
  add column if not exists mail_from text,
  add column if not exists mail_account text,
  add column if not exists message_id text;
create unique index if not exists admin_todos_message_id_key on public.admin_todos (message_id) where message_id is not null;

-- An email kept as a receipt is stored as text/plain (shown in a sandboxed frame, never served as a page).
update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf', 'text/plain']
 where id = 'finance-receipts';

-- Every 10 minutes, the same way as the other syncs (cloned from creator-store-sync's job).
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'mailbox-poll')
     and exists (select 1 from cron.job where jobname = 'creator-store-sync') then
    perform cron.schedule('mailbox-poll', '*/10 * * * *',
      (select replace(command, 'creator-store-sync', 'mailbox-poll') from cron.job where jobname = 'creator-store-sync'));
  end if;
end $$;
