-- ============================================================
-- จอลูกค้า (คาราโอเกะ) ตามตอนร้านกดหยุด / เลื่อนเพลง
--
-- 1. store_now_playing เก็บสถานะการเล่นจริงจากเครื่องเล่นของร้าน
--    (เล่น/หยุด + ตำแหน่ง ณ เวลา position_at) — เครื่องเล่นรายงานเฉพาะตอนมีเหตุการณ์
-- 2. เปลี่ยนเพลง (video/started_at เปลี่ยน) → ล้างสถานะกลับเป็น "เล่น" ตั้งแต่ต้นเพลง
-- 3. ทุกครั้งที่แถวเปลี่ยน → ส่ง Realtime Broadcast (private) ไปหัวข้อ music-playback:<store_id>
--    มือถือลูกค้าฟังหัวข้อนี้ จึงตามได้ทันทีโดยไม่ต้อง poll ถี่ (ไม่เพิ่มค่า Vercel)
--    ส่งเฉพาะร้านที่เปิดจอลูกค้า + เปิดรับขอเพลง + ใบอนุญาตเพลงอนุมัติแล้ว
-- 4. ลูกค้า (anon) อ่านได้เฉพาะหัวข้อ music-playback:* ส่งข้อความเองไม่ได้ (ไม่มี policy insert)
-- ============================================================

alter table store_now_playing
  add column if not exists playback_state text not null default 'playing',
  add column if not exists position_seconds numeric(10, 2),
  add column if not exists position_at timestamptz;

do $$
begin
  alter table store_now_playing
    add constraint store_now_playing_playback_state_check
    check (playback_state in ('playing', 'paused'));
exception when duplicate_object then null;
end $$;

-- 2. เพลงใหม่ = เริ่มเล่นจากต้นเพลง ------------------------------------------
create or replace function store_now_playing_reset_playback()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.youtube_video_id is not distinct from old.youtube_video_id
     and new.started_at is not distinct from old.started_at then
    return new;
  end if;
  -- แถวใหม่ / เปลี่ยนเพลง: ถ้าคำสั่งไม่ได้ตั้งค่ามาเอง ให้กลับเป็น "เล่น" จากต้นเพลง
  if tg_op = 'INSERT' and new.position_at is not null then
    return new;
  end if;
  new.playback_state := 'playing';
  new.position_seconds := null;
  new.position_at := null;
  return new;
end;
$$;

drop trigger if exists store_now_playing_reset_playback on store_now_playing;
create trigger store_now_playing_reset_playback
  before insert or update on store_now_playing
  for each row execute function store_now_playing_reset_playback();

-- 3. Broadcast ไปจอลูกค้า ----------------------------------------------------
create or replace function store_now_playing_broadcast()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row store_now_playing%rowtype;
  v_allowed boolean;
begin
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;

  select coalesce(sps.customer_screen_enabled, false)
         and s.music_request_enabled
         and s.music_license_status = 'approved'
    into v_allowed
    from stores s
    left join store_music_player_settings sps on sps.store_id = s.id
   where s.id = v_row.store_id;

  if not coalesce(v_allowed, false) then
    return null;
  end if;

  begin
    perform realtime.send(
      jsonb_build_object(
        'videoId', case when tg_op = 'DELETE' then null else v_row.youtube_video_id end,
        'title', v_row.title,
        'durationSeconds', v_row.duration_seconds,
        'startedAt', v_row.started_at,
        'state', v_row.playback_state,
        'positionSeconds', v_row.position_seconds,
        'positionAt', v_row.position_at,
        'sentAt', now()
      ),
      'playback',
      'music-playback:' || v_row.store_id::text,
      true
    );
  exception when others then
    -- Broadcast ล้มต้องไม่ทำให้เครื่องเล่นของร้านเปลี่ยนเพลงไม่ได้
    raise warning 'music playback broadcast failed: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function store_now_playing_broadcast() from public, anon, authenticated;

drop trigger if exists store_now_playing_broadcast on store_now_playing;
create trigger store_now_playing_broadcast
  after insert or update or delete on store_now_playing
  for each row execute function store_now_playing_broadcast();

-- 4. ลูกค้าฟังหัวข้อ music-playback:* ได้ (อ่านอย่างเดียว) ----------------------
drop policy if exists "music playback: anyone can receive" on realtime.messages;
create policy "music playback: anyone can receive"
  on realtime.messages for select
  to anon, authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'music-playback:%'
  );
