-- คิวงานพิมพ์: เริ่มวันใหม่ด้วยคิวสะอาด (ล้างงานค้างข้ามคืน)
--
-- เจอจากหน้างานจริง (each other II, 2026-09-04): Print Hub ของร้านออฟไลน์ตั้งแต่ 1 ก.ค.
-- แต่ POS ยังส่งงานเข้าคิวทุกใบตลอดสองเดือน สะสมเป็นงานค้าง 861 ใบ พอเปิด Hub ขึ้นมา
-- agent เริ่มพิมพ์ย้อนหลังทันทีรอบละ 5 ใบ ถ้าไม่หยุดจะพิมพ์จนกระดาษหมดม้วน
--
-- กติกา: งานที่ค้างข้ามเที่ยงคืน (ตามเวลาของร้าน) ถือว่าหมดความหมาย ไม่ถูกแจกให้ agent
-- อีกและถูกปิดเป็น failed พร้อมเหตุผลที่อ่านออก — ไม่ลบทิ้งเงียบ ๆ ร้านยังเห็นได้ว่ามีอะไร
-- ไม่ได้พิมพ์ และ **บิลเก่าสั่งพิมพ์ย้อนหลังจากประวัติได้อยู่แล้ว** จึงไม่มีอะไรสูญหายจริง
--
-- ทำไมไม่ทำเป็น cron: โควตา cron ของ Vercel เต็มแล้ว จึงเรียกแบบ lazy ตอน poll เหมือน
-- reconcile_stale_print_jobs — ผลลัพธ์เหมือนกันคือรอบแรกของวันใหม่จะเคลียร์ของเมื่อวานทิ้ง

/** เที่ยงคืนล่าสุดตามเวลาของร้าน (คืนค่าเป็น timestamptz) */
create or replace function store_day_start(p_store_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select date_trunc(
           'day',
           now() at time zone coalesce((select s.timezone from stores s where s.id = p_store_id), 'Asia/Bangkok')
         ) at time zone coalesce((select s.timezone from stores s where s.id = p_store_id), 'Asia/Bangkok');
$$;

-- เผื่อ environment ที่เคยมีเวอร์ชันรับจำนวนชั่วโมง (ระหว่างพัฒนา) — ตัดทิ้งไม่ให้ชื่อซ้อนกัน
drop function if exists expire_old_print_jobs(uuid, integer);
drop function if exists claim_print_jobs(uuid, integer, integer, text, integer);

create or replace function expire_old_print_jobs(p_store_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := store_day_start(p_store_id);
  v_count integer;
begin
  with expired as (
    update print_jobs
    set status = 'failed',
        error = 'ยกเลิกอัตโนมัติ — งานค้างข้ามคืน (สั่งพิมพ์ย้อนหลังจากประวัติบิลได้)'
    where store_id = p_store_id
      and status = 'pending'
      and created_at < v_cutoff
    returning 1
  )
  select count(*)::integer into v_count from expired;
  return coalesce(v_count, 0);
end;
$$;

-- claim ต้องไม่หยิบงานของเมื่อวานด้วย (กันจังหวะที่ expire ยังไม่ทันวิ่ง)
-- เปลี่ยน signature จึงต้อง drop ก่อน
drop function if exists claim_print_jobs(uuid, integer, integer, text);

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
  v_cutoff timestamptz := store_day_start(p_store_id);
begin
  return query
  with picked as (
    select j.id
    from print_jobs j
    where j.store_id = p_store_id
      and j.status = 'pending'
      and j.created_at >= v_cutoff
    order by j.created_at
    limit v_limit
    for update skip locked
  )
  update print_jobs j
  set status = 'claimed',
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      attempts = j.attempts + 1,
      claim_token = gen_random_uuid()::text,
      agent_version = nullif(p_agent_version, ''),
      error = null
  from picked
  where j.id = picked.id
  returning j.id, j.target_kind, j.target_host, j.target_port,
            j.target_device, j.payload_b64, j.claim_token, j.attempts;
end;
$$;

revoke all on function store_day_start(uuid) from public, anon, authenticated;
revoke all on function expire_old_print_jobs(uuid) from public, anon, authenticated;
revoke all on function claim_print_jobs(uuid, integer, integer, text) from public, anon, authenticated;
