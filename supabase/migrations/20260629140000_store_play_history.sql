-- ============================================================
-- Music player: play history (for "previous track" + history panel).
-- One row per track that started playing (request or base playlist).
-- Writes go through the service-client advance flow; staff read via RLS.
-- ============================================================

create table if not exists store_play_history (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  music_request_id uuid references music_requests(id) on delete set null,
  source text not null default 'base' check (source in ('request', 'base')),
  youtube_video_id text,
  title text,
  played_at timestamptz not null default now()
);

create index if not exists store_play_history_store_played_idx
  on store_play_history(store_id, played_at desc);

alter table store_play_history enable row level security;

create policy "store_play_history: store member can read"
  on store_play_history for select
  using (store_id in (select auth_user_store_ids()));

create policy "store_play_history: deny client write"
  on store_play_history for insert with check (false);
