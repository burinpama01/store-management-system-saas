-- ============================================================
-- QR Music Player (auto-play + donation queue-jump).
--
-- Extends the music_requests queue into an auto-advancing player:
--   - YouTube source fields on each request
--   - donation fields (amount used only for ordering; verified via slip)
--   - per-store player settings (base playlist, auto-approve, donation toggle)
--   - a single "now playing" row per store for player/customer sync
--
-- Selection / advance / donation-verify logic lives in TypeScript
-- (pure queue-engine + server actions reusing slip2go), not SQL RPCs.
-- ============================================================

-- 1. Extend music_requests -------------------------------------------------
alter table music_requests
  add column if not exists youtube_video_id text,
  add column if not exists youtube_title text,
  add column if not exists thumbnail_url text,
  add column if not exists duration_seconds integer
    check (duration_seconds is null or (duration_seconds > 0 and duration_seconds <= 1800)),
  add column if not exists donation_amount numeric(12,2) not null default 0
    check (donation_amount >= 0),
  add column if not exists donation_status text not null default 'none'
    check (donation_status in ('none', 'pending', 'verified', 'rejected')),
  add column if not exists donation_slip_url text,
  add column if not exists donation_ref text;

-- A slip reference can back at most one donation (prevents slip reuse).
create unique index if not exists music_requests_donation_ref_uniq
  on music_requests(donation_ref)
  where donation_ref is not null;

-- Queue ordering: verified donations (amount desc) then FIFO.
create index if not exists music_requests_store_queue_idx
  on music_requests(store_id, donation_status, donation_amount desc, requested_at);

-- 2. Per-store player settings + base playlist -----------------------------
create table if not exists store_music_player_settings (
  store_id uuid primary key references stores(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  player_enabled boolean not null default false,
  auto_approve boolean not null default true,
  donation_enabled boolean not null default false,
  min_donation numeric(12,2) not null default 10 check (min_donation >= 0),
  max_duration_seconds integer not null default 600
    check (max_duration_seconds > 0 and max_duration_seconds <= 1800),
  base_playlist jsonb not null default '[]'::jsonb,
  licensing_acknowledged_at timestamptz,
  updated_at timestamptz not null default now()
);

-- 3. Now-playing (one row per store) ---------------------------------------
create table if not exists store_now_playing (
  store_id uuid primary key references stores(id) on delete cascade,
  music_request_id uuid references music_requests(id) on delete set null,
  source text not null default 'base' check (source in ('request', 'base')),
  youtube_video_id text,
  title text,
  duration_seconds integer,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 4. RLS -------------------------------------------------------------------
alter table store_music_player_settings enable row level security;
alter table store_now_playing enable row level security;

-- Settings: store members read; manager+ writes (customer reads via service client).
create policy "store_music_player_settings: store member can read"
  on store_music_player_settings for select
  using (store_id in (select auth_user_store_ids()));

create policy "store_music_player_settings: manager+ can insert"
  on store_music_player_settings for insert
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create policy "store_music_player_settings: manager+ can update"
  on store_music_player_settings for update
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

-- Now-playing: store members read; writes go through service-client actions.
create policy "store_now_playing: store member can read"
  on store_now_playing for select
  using (store_id in (select auth_user_store_ids()));

create policy "store_now_playing: deny client write"
  on store_now_playing for insert with check (false);

-- 5. Realtime --------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table store_now_playing;
  exception when duplicate_object then null;
  end;
end $$;
