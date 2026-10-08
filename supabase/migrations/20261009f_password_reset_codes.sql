-- Password reset by emailed code, handled entirely by the password-reset-code edge function
-- (the Supabase dashboard "Reset password" template sends a link; our UI asks for a code).
create table if not exists public.password_reset_codes (
  email text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  last_sent_at timestamptz not null default now()
);
alter table public.password_reset_codes enable row level security;
-- service role only; no policies on purpose.

-- Look up an auth user by email for the edge function (service role only).
create or replace function public.auth_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;
revoke all on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;
