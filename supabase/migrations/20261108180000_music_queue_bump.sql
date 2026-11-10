-- ============================================================
-- ลูกค้ากด "⏫ ขอเล่นก่อน" ที่เพลงในคิว (จ่ายโดเนทแบบเดิม: เปิดทันที / เข้าคิวแรก)
--
-- ทำเป็นคำขอโดเนทใหม่ของเพลงเดียวกัน ผูกกับคำขอเดิมผ่าน bump_of_request_id
-- - ยังไม่จ่าย: แอปไม่นับเป็นคิว (ไม่ให้เพลงซ้ำในคิว / ไม่ให้เล่นฟรี)
-- - จ่ายแล้ว (donation_status → verified ทุกทาง: Beam / สลิป / ราคา 0): trigger ข้ามคำขอเดิมที่ยังรอคิว
--   เพลงจึงเล่นครั้งเดียวในลำดับใหม่
-- ============================================================

alter table music_requests
  add column if not exists bump_of_request_id uuid references music_requests(id) on delete set null;

create index if not exists music_requests_bump_of_idx
  on music_requests (bump_of_request_id)
  where bump_of_request_id is not null;

-- กันกดดันเพลงเดียวกันพร้อมกัน (จ่ายซ้อน → เพลงเข้าคิวสองรอบ): รอจ่ายได้ทีละรายการต่อเพลงเดิม
-- แอปปิดรายการรอจ่ายที่ค้างเกิน 15 นาทีก่อนสร้างใหม่ จึงไม่ค้างถาวร
create unique index if not exists music_requests_one_pending_bump_idx
  on music_requests (bump_of_request_id)
  where bump_of_request_id is not null
    and donation_status = 'pending'
    and status in ('pending', 'approved');

-- หมายเหตุ: ถ้าเพลงเดิมถูกเล่นไปก่อนที่ลูกค้าจ่ายเสร็จ trigger จะหาเพลงเดิมไม่เจอ (ไม่ใช่ pending/approved)
-- คำขอที่จ่ายแล้วยังเข้าคิวตามปกติ — ลูกค้าจ่ายแล้วได้ฟังเพลงนั้นอีกรอบตามลำดับที่จ่าย (ตั้งใจ)

create or replace function music_requests_apply_bump()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update music_requests
     set status = 'skipped',
         decided_at = coalesce(decided_at, now()),
         updated_at = now()
   where id = new.bump_of_request_id
     and store_id = new.store_id
     and status in ('pending', 'approved');
  return null;
end;
$$;

revoke all on function music_requests_apply_bump() from public, anon, authenticated;

drop trigger if exists music_requests_apply_bump on music_requests;
create trigger music_requests_apply_bump
  after insert or update of donation_status on music_requests
  for each row
  when (new.bump_of_request_id is not null and new.donation_status = 'verified')
  execute function music_requests_apply_bump();
