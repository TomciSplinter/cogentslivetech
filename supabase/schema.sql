-- ============================================================
-- Cogents database schema
-- Run once: Supabase dashboard → SQL Editor → New query → paste all → Run
-- Safe to re-run.
-- ============================================================

-- Bots (written by the engine, read by the website)
create table if not exists public.bots (
  id            text primary key,
  name          text not null,
  role          text not null default '',
  color         text not null default '#3fd0ff',
  mode          text not null default 'paper' check (mode in ('paper','real')),
  wallet        text,
  sol_balance   numeric not null default 0,
  start_sol     numeric not null default 0,
  status        text not null default '',
  thinking      text not null default '',
  watching_mint text,
  trades_today  int not null default 0,
  updated_at    timestamptz not null default now()
);

-- Columns for user-created bots (safe to re-run)
alter table public.bots add column if not exists owner       text;
alter table public.bots add column if not exists preset      text;
alter table public.bots add column if not exists persona_bio text;
alter table public.bots add column if not exists voice_id    text;
alter table public.bots add column if not exists limits      jsonb not null default '{}';
alter table public.bots add column if not exists is_house    boolean not null default false;
alter table public.bots add column if not exists paused      boolean not null default false;
alter table public.bots add column if not exists created_at  timestamptz not null default now();
create index if not exists bots_owner on public.bots (owner);

-- Lifetime performance per bot (leaderboard)
alter table public.bots add column if not exists realized_pnl  numeric not null default 0;
alter table public.bots add column if not exists wins          int     not null default 0;
alter table public.bots add column if not exists losses        int     not null default 0;
alter table public.bots add column if not exists volume_sol    numeric not null default 0;
alter table public.bots add column if not exists withdrawn_sol numeric not null default 0;
-- When the bot's current stream started (shown as uptime)
alter table public.bots add column if not exists live_since timestamptz;

-- Encrypted wallet keys of real-money user bots. NEVER readable from the website.
create table if not exists public.bot_secrets (
  bot_id     text primary key references public.bots(id) on delete cascade,
  secret_enc text not null,
  created_at timestamptz not null default now()
);

-- Which bot is live on Cogents TV / Twitch right now
create table if not exists public.tv_state (
  id     int primary key default 1 check (id = 1),
  bot_id text references public.bots(id) on delete set null,
  since  timestamptz not null default now()
);
-- Live SOL price in USD (the engine updates it every minute; the website shows market caps in $)
alter table public.tv_state add column if not exists sol_usd numeric;

-- Open bags
create table if not exists public.positions (
  bot_id      text not null references public.bots(id) on delete cascade,
  mint        text not null,
  symbol      text not null,
  tokens      numeric not null,
  cost_sol    numeric not null,
  entry_price numeric not null,
  opened_at   timestamptz not null default now(),
  primary key (bot_id, mint)
);

-- Every trade ever made
create table if not exists public.trades (
  id         bigint generated always as identity primary key,
  bot_id     text not null references public.bots(id) on delete cascade,
  mint       text not null,
  symbol     text not null,
  side       text not null check (side in ('buy','sell')),
  sol        numeric not null,
  tokens     numeric not null,
  price      numeric not null,
  pnl_sol    numeric,
  reason     text,
  tx         text,
  mode       text not null default 'paper',
  created_at timestamptz not null default now()
);
create index if not exists trades_bot_time on public.trades (bot_id, created_at desc);

-- What the bots say on stream (with optional voice clip)
create table if not exists public.utterances (
  id         bigint generated always as identity primary key,
  bot_id     text not null references public.bots(id) on delete cascade,
  kind       text not null default 'think',
  text       text not null,
  audio_url  text,
  reply_to   text,
  created_at timestamptz not null default now()
);
create index if not exists utterances_bot_time on public.utterances (bot_id, created_at desc);

-- Viewer chat
create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  bot_id     text not null references public.bots(id) on delete cascade,
  viewer_id  text not null,
  username   text not null,
  text       text not null,
  created_at timestamptz not null default now(),
  constraint chat_username_len check (char_length(username) between 1 and 24),
  constraint chat_text_len check (char_length(text) between 1 and 200)
);
create index if not exists chat_bot_id on public.chat_messages (bot_id, id desc);

-- Who is watching (heartbeat every ~15s from the stream page)
create table if not exists public.viewers (
  bot_id    text not null references public.bots(id) on delete cascade,
  viewer_id text not null,
  last_seen timestamptz not null default now(),
  primary key (bot_id, viewer_id)
);

-- Live coin snapshots for charts
create table if not exists public.coins (
  mint       text primary key,
  symbol     text not null,
  name       text not null default '',
  mcap_sol   numeric not null default 0,
  price_sol  numeric not null default 0,
  progress   numeric not null default 0,
  created_at timestamptz not null default now(),
  history    jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
-- 5-second candles (open/high/low/close in market cap SOL, plus volume)
alter table public.coins add column if not exists candles jsonb not null default '[]';
-- Smart money: how many followed wallets bought this coin in the last 10 minutes
alter table public.coins add column if not exists smart_buyers int not null default 0;

-- ------------------------------------------------------------
-- Chat flood protection: one message per viewer every 2 seconds
-- ------------------------------------------------------------
create or replace function public.chat_rate_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.chat_messages
    where viewer_id = new.viewer_id and created_at > now() - interval '2 seconds'
  ) then
    raise exception 'slow down';
  end if;
  new.created_at := now();
  return new;
end $$;

drop trigger if exists chat_rate_limit on public.chat_messages;
create trigger chat_rate_limit before insert on public.chat_messages
for each row execute function public.chat_rate_limit();

-- ------------------------------------------------------------
-- Security (Row Level Security)
-- The website (public key) may READ everything shown on stream,
-- may WRITE only chat messages and viewer heartbeats.
-- The engine uses the secret key, which bypasses these rules.
-- ------------------------------------------------------------
alter table public.bots          enable row level security;
alter table public.positions     enable row level security;
alter table public.trades        enable row level security;
alter table public.utterances    enable row level security;
alter table public.chat_messages enable row level security;
alter table public.viewers       enable row level security;
alter table public.coins         enable row level security;
alter table public.bot_secrets   enable row level security;
alter table public.tv_state      enable row level security;
-- bot_secrets: no policies at all = only the engine's secret key can touch it
revoke all on public.bot_secrets from anon, authenticated;

drop policy if exists "public read" on public.bots;
create policy "public read" on public.bots for select using (true);
drop policy if exists "public read" on public.positions;
create policy "public read" on public.positions for select using (true);
drop policy if exists "public read" on public.trades;
create policy "public read" on public.trades for select using (true);
drop policy if exists "public read" on public.utterances;
create policy "public read" on public.utterances for select using (true);
drop policy if exists "public read" on public.coins;
create policy "public read" on public.coins for select using (true);
drop policy if exists "public read" on public.tv_state;
create policy "public read" on public.tv_state for select using (true);

-- chat: anyone can read and post (limits enforced by constraints + trigger)
drop policy if exists "public read" on public.chat_messages;
create policy "public read" on public.chat_messages for select using (true);
drop policy if exists "public post" on public.chat_messages;
create policy "public post" on public.chat_messages for insert with check (true);

-- viewers: heartbeat upsert, never readable by the public
drop policy if exists "heartbeat insert" on public.viewers;
create policy "heartbeat insert" on public.viewers for insert with check (true);
drop policy if exists "heartbeat update" on public.viewers;
create policy "heartbeat update" on public.viewers for update using (true) with check (true);
drop policy if exists "heartbeat select" on public.viewers;
create policy "heartbeat select" on public.viewers for select using (true);

-- ------------------------------------------------------------
-- Realtime: push new lines, chat and trades to the website instantly
-- ------------------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table public.utterances; exception when others then null; end;
  begin alter publication supabase_realtime add table public.chat_messages; exception when others then null; end;
  begin alter publication supabase_realtime add table public.trades; exception when others then null; end;
  begin alter publication supabase_realtime add table public.bots; exception when others then null; end;
end $$;

-- ------------------------------------------------------------
-- Storage bucket for voice clips (public read, engine writes)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('voice', 'voice', true)
on conflict (id) do update set public = true;
