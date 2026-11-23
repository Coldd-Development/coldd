-- inbound_emails: every email the sales-mail-poll function reads from the
-- sales@coldd.dev mailbox (Migadu, over IMAP), ClearlyDev order notifications first. Kept whole, so an email the parser
-- could not read can be re-read after the parser is fixed, and the admin can
-- see what arrived. Written by the sales-mail-poll function (service role).
create table if not exists public.inbound_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text unique,
  received_at timestamptz not null default now(),
  sent_at timestamptz,
  mail_from text,
  rcpt_to text,
  subject text,
  platform text,
  external_id text,
  status text not null default 'received' check (status in ('received', 'parsed', 'ignored', 'failed')),
  error text,
  text_body text,
  html_body text
);
create index if not exists inbound_emails_received_idx on public.inbound_emails (received_at desc);
create index if not exists inbound_emails_status_idx on public.inbound_emails (status, received_at desc);
alter table public.inbound_emails enable row level security;

do $$ begin
  create policy "inbound_emails_admin_read" on public.inbound_emails
    for select using (public.is_admin());
exception when duplicate_object then null;
end $$;

revoke all on public.inbound_emails from anon, authenticated;
grant select on public.inbound_emails to authenticated;

-- Email-fed sales are tagged source 'email' (already allowed by platform_sales).
