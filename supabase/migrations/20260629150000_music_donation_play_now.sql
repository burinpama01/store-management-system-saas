-- ============================================================
-- Music donation tier: "play now" (interrupt) vs "queue jump".
-- play_now donations (min higher amount) play immediately.
-- ============================================================

alter table music_requests
  add column if not exists donation_play_now boolean not null default false;
