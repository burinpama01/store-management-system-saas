-- ============================================================
-- Task U11 (v0.37.2) — Replay-safe print intent ของ unified POS
-- ตามแผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U11)
--
-- พื้นหลัง: print_jobs เดิม (20260625120000) ไม่มีกลไก idempotency ใดๆ — job ทุกแถว
-- เกิดจากการ enqueue ข้างเดียวของ client (POST /api/print/enqueue) จึงไม่เคยซ้ำ
-- แต่เมื่อ U11 ทำ print intent หลัง settlement (executed/replayed) ฝั่ง server
-- ต้องรับประกัน: replay ของคำขอชำระเงินเดิม → ได้ print job id ชุดเดิม
-- (ไม่ duplicate ใบเสร็จ/ตั๋วครัว) — ตามคอมเมนต์ print intent ของ migration
-- 20260901000005 ที่เผื่อ convention source key "unified_pos_settlement:<operation_key>:..."
-- ไว้แล้ว
--
-- เนื้อหา:
--   a) print_jobs.source_key — คีย์กำกับต้นทางของ job (null = job แบบเดิมจาก client
--      enqueue ตรง ๆ ซึ่ง unique บน NULL ไม่บังคับ: PostgreSQL unique index ยอมรับ
--      NULL ซ้ำได้ พฤติกรรม legacy จึงไม่เปลี่ยน)
--   b) unique (source_key) — กลไก dedupe ระดับ schema: intent ที่เล่นซ้ำ (same
--      operation key) insert ด้วย key เดิมไม่ได้ → อ่านแถวเดิมคืน id เดิมเสมอ
--      (Print Hub ยังใช้ lifecycle เดิม: pending → claimed → printed|failed
--      ต่อแถวเดียว — retry ของ Hub ไม่สร้างแถวใหม่อยู่แล้ว)
--   c) print_jobs.job_kind — ชนิดงานเพื่อให้ UI/audit/เทสต์แยกใบเสร็จกับตั๋วครัว
--      ได้โดยไม่ต้อง parse payload bytes (null = อื่น ๆ / legacy)
-- ============================================================

alter table public.print_jobs
  add column if not exists source_key text;

create unique index if not exists print_jobs_source_key_uq
  on public.print_jobs (source_key);

alter table public.print_jobs
  add column if not exists job_kind text;

do $$
begin
  alter table public.print_jobs
    add constraint print_jobs_job_kind_check
    check (job_kind in ('receipt', 'station_ticket'));
exception
  when duplicate_object then null; -- re-run ได้ (idempotent migration)
end $$;

comment on column public.print_jobs.source_key is
  'U11: unique source key ของ print intent (เช่น unified_pos_settlement:<operation_key>:receipt) — replay ของ operation เดิมคืน job id เดิม; NULL = job แบบ legacy จาก client enqueue';
comment on column public.print_jobs.job_kind is
  'U11: ชนิดงานของ intent — receipt (ใบเสร็จ) หรือ station_ticket (ตั๋วครัว); NULL = อื่น ๆ';
