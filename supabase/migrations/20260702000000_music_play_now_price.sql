-- Store-adjustable "play now" price for music donations. Previously hardcoded to
-- max(100, min_donation) in code; now each store sets its own price alongside the
-- queue-jump minimum (min_donation).

alter table store_music_player_settings
  add column if not exists play_now_price numeric(12,2) not null default 100
    check (play_now_price >= 0);
