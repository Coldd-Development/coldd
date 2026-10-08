-- Server-side length limits on text that visitors / signed-in users can write straight to the
-- database (the browser maxlength is only the first line of defence; anyone can skip the page and
-- call the API). Existing limits on client_errors.message/stack/user_agent/page_url and
-- consent_log.visitor_id/page stay as they are.
alter table public.profiles drop constraint if exists profiles_username_len;
alter table public.profiles add constraint profiles_username_len check (username is null or char_length(username) <= 32);
alter table public.profiles drop constraint if exists profiles_avatar_len;
alter table public.profiles add constraint profiles_avatar_len check (avatar_url is null or char_length(avatar_url) <= 500);
alter table public.profiles drop constraint if exists profiles_ban_reason_len;
alter table public.profiles add constraint profiles_ban_reason_len check (ban_reason is null or char_length(ban_reason) <= 500);
alter table public.profiles drop constraint if exists profiles_referral_len;
alter table public.profiles add constraint profiles_referral_len check (referral_code is null or char_length(referral_code) <= 64);
alter table public.profiles drop constraint if exists profiles_ids_len;
alter table public.profiles add constraint profiles_ids_len check ((discord_id is null or char_length(discord_id) <= 40) and (roblox_id is null or char_length(roblox_id) <= 40));
alter table public.profiles drop constraint if exists profiles_json_len;
alter table public.profiles add constraint profiles_json_len check (char_length(coalesce(member_info::text, '')) <= 20000 and char_length(coalesce(notification_prefs::text, '')) <= 2000);

alter table public.client_errors drop constraint if exists client_errors_small_fields_len;
alter table public.client_errors add constraint client_errors_small_fields_len check (
  (code is null or char_length(code) <= 100) and (fn_name is null or char_length(fn_name) <= 200) and (kind is null or char_length(kind) <= 100)
  and char_length(coalesce(context::text, '')) <= 8000);
