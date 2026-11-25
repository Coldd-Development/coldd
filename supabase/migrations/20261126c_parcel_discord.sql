-- Parcel sales and reviews from coldd's Discord bot (coldd-dc-bot, cog coldd_feed).
--
-- The bot forwards every message Parcel's bot posts in the purchases and reviews
-- channels, unread, to platform-sales-ingest. Each one is kept here as it came, so
-- the reading can be fixed and re-run on old messages without touching the bot.
--
-- The bot signs in with a key it makes itself; only the key's SHA-256 is stored.
-- A new key starts 'pending' and the owner approves it by matching the pairing
-- code the bot prints in its console with the fingerprint here.

create table if not exists public.discord_feed_messages (
  message_id text primary key,
  guild_id text,
  channel_id text not null,
  kind text not null check (kind in ('purchase', 'review', 'other')),
  author_id text,
  author_name text,
  author_bot boolean,
  posted_at timestamptz not null,
  edited_at timestamptz,
  content text,
  embeds jsonb not null default '[]'::jsonb,
  extra jsonb,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  parse_status text not null default 'new' check (parse_status in ('new', 'parsed', 'ignored', 'failed')),
  parsed jsonb,
  parse_error text,
  sale_id uuid,
  review_id uuid
);
create index if not exists discord_feed_messages_channel_posted on public.discord_feed_messages (channel_id, posted_at desc);
create index if not exists discord_feed_messages_status on public.discord_feed_messages (parse_status) where parse_status in ('new', 'failed');
alter table public.discord_feed_messages enable row level security;

create table if not exists public.bot_ingest_keys (
  key_hash text primary key,
  fingerprint text not null,
  label text,
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  last_used_at timestamptz,
  meta jsonb
);
alter table public.bot_ingest_keys enable row level security;

revoke all on public.discord_feed_messages from anon, authenticated;
revoke all on public.bot_ingest_keys from anon, authenticated;
