-- ============================================================
-- QR ขอเพลงของร้าน (ไม่ผูกโต๊ะ) — 2026-09-18
--
-- ร้านที่ไม่ได้เปิด QR Order ก็ให้ลูกค้าสแกน QR ขอเพลงได้ (หน้า /music/[storeSlug])
-- create_music_request เดิมบังคับ qr_ordering_enabled + โต๊ะที่ถูกต้องเสมอ
--
-- เปลี่ยนเฉพาะ: p_table_id = null → คำขอระดับร้าน
--   * ไม่ต้องเปิด QR Order และไม่มีโต๊ะ/รอบบิล (table_number/session_id เป็น null)
--   * ด่าน Enterprise + ใบอนุญาต approved + สวิตช์ขอเพลงของร้าน ยังบังคับเหมือนเดิมทุกข้อ
-- p_table_id ไม่ null = พฤติกรรมเดิมทุกอย่าง (รวม qr_ordering_enabled + gate ของ session_printed)
-- signature เดิม — grant เดิมยังใช้ได้
-- ============================================================

create or replace function create_music_request(
  p_store_id uuid,
  p_table_id uuid,
  p_session_id uuid,
  p_song_title text,
  p_artist_name text default null,
  p_requester_label text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_qr_mode text;
  v_music_enabled boolean;
  v_license_status text;
  v_plan text;
  v_sub_status text;
  v_table_number text;
  v_current_session_id uuid;
  v_session_expires_at timestamptz;
  v_song text;
  v_artist text;
  v_requester text;
  v_note text;
  v_request_id uuid;
begin
  -- Resolve store + music config.
  select organization_id, qr_ordering_mode, music_request_enabled, music_license_status
    into v_org_id, v_qr_mode, v_music_enabled, v_license_status
    from stores
    where id = p_store_id
      and is_active = true
      -- QR ขอเพลงของร้าน (ไม่มีโต๊ะ) ไม่ต้องเปิด QR Order
      and (p_table_id is null or qr_ordering_enabled = true);
  if not found then
    raise exception 'ร้านไม่พร้อมรับคำขอ';
  end if;

  -- Enterprise plan gate (active / trialing / past_due grace).
  select plan, status
    into v_plan, v_sub_status
    from subscriptions
    where organization_id = v_org_id
    order by created_at desc
    limit 1;
  if v_plan is distinct from 'enterprise'
     or v_sub_status not in ('active', 'trialing', 'past_due') then
    raise exception 'ฟีเจอร์ขอเพลงสำหรับแพ็กเกจ Enterprise เท่านั้น';
  end if;

  -- License + store toggle gate.
  if v_music_enabled is not true or v_license_status <> 'approved' then
    raise exception 'ร้านนี้ยังไม่เปิดให้ขอเพลง';
  end if;

  if p_table_id is not null then
    -- Resolve table + session window.
    select number, current_session_id, session_expires_at
      into v_table_number, v_current_session_id, v_session_expires_at
      from tables
      where id = p_table_id
        and organization_id = v_org_id
        and store_id = p_store_id
        and is_active = true
        and qr_enabled = true;
    if not found then
      raise exception 'โต๊ะไม่ถูกต้อง';
    end if;

    -- QR session gate. table_bound: always allowed (even after checkout).
    -- session_printed: query session must match the active session.
    if v_qr_mode = 'session_printed' then
      if v_current_session_id is null
         or p_session_id is null
         or p_session_id <> v_current_session_id
         or (v_session_expires_at is not null and v_session_expires_at <= now()) then
        raise exception 'QR หมดอายุแล้ว กรุณาขอ QR ใหม่จากพนักงาน';
      end if;
    end if;
  else
    -- คำขอระดับร้าน: ไม่มีโต๊ะ ไม่มีรอบบิล
    v_table_number := null;
    v_current_session_id := null;
  end if;

  -- Validate + normalize input.
  v_song := btrim(coalesce(p_song_title, ''));
  if char_length(v_song) < 1 or char_length(v_song) > 120 then
    raise exception 'ชื่อเพลงต้องมีความยาว 1-120 ตัวอักษร';
  end if;
  v_artist := nullif(btrim(coalesce(p_artist_name, '')), '');
  if v_artist is not null and char_length(v_artist) > 120 then
    raise exception 'ชื่อศิลปินยาวเกินไป';
  end if;
  v_requester := nullif(btrim(coalesce(p_requester_label, '')), '');
  if v_requester is not null and char_length(v_requester) > 60 then
    raise exception 'ชื่อผู้ขอยาวเกินไป';
  end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 240 then
    raise exception 'หมายเหตุยาวเกินไป';
  end if;

  insert into music_requests (
    store_id, organization_id, table_id, table_number, session_id,
    requester_label, song_title, artist_name, note
  )
  values (
    p_store_id, v_org_id, p_table_id, v_table_number, v_current_session_id,
    v_requester, v_song, v_artist, v_note
  )
  returning id into v_request_id;

  insert into music_request_audit_logs (
    store_id, music_request_id, actor_user_id, actor_type, action, details
  )
  values (
    p_store_id, v_request_id, null, 'customer', 'submitted',
    jsonb_build_object('table_id', p_table_id, 'qr_mode', case when p_table_id is null then 'store' else v_qr_mode end)
  );

  return v_request_id;
end;
$$;
