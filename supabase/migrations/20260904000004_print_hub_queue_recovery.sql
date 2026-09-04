-- StoreOS Print Hub: queue recovery (แผน v3 Task 1 — ปิด Critical X1)
--
-- ปัญหาเดิม: print_jobs มี attempts/claimed_at อยู่ในตารางตั้งแต่แรก แต่ไม่มีโค้ดไหน
-- อ่านหรือเขียนกลับเลย. เมื่อ Hub agent เคลมงานแล้วเน็ตหลุด/เครื่องดับก่อน ack งานจะ
-- ค้างสถานะ 'claimed' ตลอดไป — ไม่มี requeue ไม่มี timeout และหน้า Settings ก็มองไม่เห็น
-- เพราะนับเฉพาะ 'pending'. ผู้ใช้เจอ "ใบเสร็จไม่ออกแต่ระบบไม่ฟ้องอะไร" ซึ่งขัดกฎ
-- ห้ามสำเร็จแบบเงียบของโปรเจกต์.
--
-- หลักการที่ยึด (แผน v3 §3):
--   * งานที่ผลลัพธ์ไม่ชัดเจนต้องลงสถานะ 'unknown' ไม่ใช่ 'failed' และ
--     **ห้าม replay อัตโนมัติ** เพราะกระดาษอาจออกไปแล้วแต่ ack หาย → ใบเสร็จซ้ำ
--   * การพิมพ์ซ้ำต้องเป็นการตัดสินใจของคน (ตรวจใบจริงก่อน) และนับเป็น attempt ใหม่
--   * ไม่มี cron slot เหลือบน Vercel Hobby (crons เต็ม 2 ตัวแล้ว) → reconciliation
--     ทำแบบ lazy ตอน poll/status ผ่าน RPC ด้านล่าง ไม่ใช่ scheduled job

-- 1. สถานะใหม่ 'unknown' = เคลมไปแล้วแต่ไม่รู้ผล (lease หมดโดยไม่มี ack)
alter table print_jobs drop constraint if exists print_jobs_status_check;
alter table print_jobs
  add constraint print_jobs_status_check
  check (status in ('pending', 'claimed', 'printed', 'failed', 'unknown'));

-- 2. ฟิลด์สำหรับ claim ที่ตรวจสอบได้ + ร่องรอยการตัดสินใจของคน
--    claim_token  = โทเค็นต่อ 1 job ต่อ 1 การเคลม; ack ที่โทเค็นไม่ตรง = ack ค้างจาก
--                   รอบก่อน (agent ตัวเก่าที่ฟื้นมา) ต้องถูกปฏิเสธ ไม่ให้ทับผลรอบใหม่
--    lease_expires_at = เส้นตายที่ต้อง ack; เลยเวลานี้ถือว่า unknown
--    agent_version = เวอร์ชัน agent ที่เคลม (ไว้ไล่ปัญหาเวลาร้านรัน Hub เก่า)
--    resolution/resolved_* = คนกดตัดสินว่า "กระดาษออกแล้ว" หรือ "สั่งพิมพ์ใหม่"
alter table print_jobs
  add column if not exists claim_token text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists agent_version text,
  add column if not exists resolution text,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid;

alter table print_jobs drop constraint if exists print_jobs_resolution_check;
alter table print_jobs
  add constraint print_jobs_resolution_check
  check (resolution is null or resolution in ('printed_confirmed', 'retried'));

-- งานที่ค้าง claimed อยู่ก่อน migration นี้ไม่มี lease → ให้ lease ย้อนหลังจากเวลาเคลม
-- เพื่อให้รอบ reconcile แรกดึงมันขึ้นมาเป็น unknown ให้ร้านเห็น (ไม่พิมพ์ซ้ำให้เอง)
update print_jobs
set lease_expires_at = coalesce(claimed_at, created_at) + interval '2 minutes'
where status = 'claimed' and lease_expires_at is null;

-- index สำหรับ lazy reconciliation (หา claimed ที่ lease หมดของร้านนั้น)
create index if not exists print_jobs_store_lease_idx
  on print_jobs(store_id, status, lease_expires_at);

-- 3. Atomic claim. เดิมเป็น select-แล้ว-update สองสเต็ปจากฝั่งแอป ซึ่งถ้ามี agent
--    สองตัว (Scheduled Task + Launcher เปิดซ้ำ) จะแย่งงานกันได้. ย้ายมาเป็น RPC เดียว
--    ที่ใช้ FOR UPDATE SKIP LOCKED — งานหนึ่งใบไปได้ที่ agent เดียวเท่านั้น
create or replace function claim_print_jobs(
  p_store_id uuid,
  p_limit integer default 5,
  p_lease_seconds integer default 120,
  p_agent_version text default null
)
returns table (
  id uuid,
  target_kind text,
  target_host text,
  target_port integer,
  target_device text,
  payload_b64 text,
  claim_token text,
  attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
  v_lease integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
begin
  return query
  with picked as (
    select j.id
    from print_jobs j
    where j.store_id = p_store_id
      and j.status = 'pending'
    order by j.created_at
    limit v_limit
    for update skip locked
  )
  update print_jobs j
  set status = 'claimed',
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      attempts = j.attempts + 1,
      -- โทเค็นใหม่ทุกครั้งที่เคลม → ack ของรอบเก่าใช้ไม่ได้อีก
      claim_token = gen_random_uuid()::text,
      agent_version = nullif(p_agent_version, ''),
      error = null
  from picked
  where j.id = picked.id
  returning j.id, j.target_kind, j.target_host, j.target_port,
            j.target_device, j.payload_b64, j.claim_token, j.attempts;
end;
$$;

-- 4. Lazy reconciliation: งานที่เคลมไปแล้วแต่ lease หมดโดยไม่มี ack → 'unknown'
--    ไม่ย้อนเป็น pending เด็ดขาด เพราะกระดาษอาจออกแล้ว การพิมพ์ซ้ำต้องมีคนยืนยัน
create or replace function reconcile_stale_print_jobs(p_store_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with stale as (
    update print_jobs
    set status = 'unknown',
        error = coalesce(
          error,
          'ไม่ได้รับผลยืนยันจาก Print Hub — ตรวจว่ากระดาษออกแล้วหรือยังก่อนสั่งพิมพ์ซ้ำ'
        )
    where store_id = p_store_id
      and status = 'claimed'
      and lease_expires_at is not null
      and lease_expires_at < now()
    returning 1
  )
  select count(*)::integer into v_count from stale;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function claim_print_jobs(uuid, integer, integer, text) from public, anon, authenticated;
revoke all on function reconcile_stale_print_jobs(uuid) from public, anon, authenticated;
