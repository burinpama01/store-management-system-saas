-- ============================================================
-- AI Assistant durable idempotency (PR3) — บันทึกผลการเรียก tool ลง DB
--
-- ทำไม: MemoryIdempotencyStore อยู่แค่ใน process เดียว — restart แล้ว ledger หาย
-- และ production (serverless หลาย instance) เคลมพร้อมกันข้าม instance ไม่ได้
-- เกตปลด production mutation จึงบังคับว่า safe_write ต้องผ่าน store ที่ durable เท่านั้น
--
-- หลักการ (แผน v2 หัวข้อ 13 — Data additive):
--   * atomic claim ด้วย UNIQUE (organization_id, idempotency_key) — insert pending ก่อน
--     execute เสมอ ใครแทงซ้ำชน constraint = มีคนกำลังทำ/เคยทำแล้ว (ไม่มีช่องว่าง check-then-insert)
--   * replay ตัดสินจากแถวเดิม: fingerprint เดิม + identity เดิม = คืนผลที่เก็บไว้,
--     ต่าง fingerprint หรือต่าง identity = IDEMPOTENCY_CONFLICT (fail-closed ไม่ execute ซ้ำ)
--   * pending ที่ค้าง (handler ตายกลางทาง) = ปฏิเสธด้วย IDEMPOTENCY_PENDING จนหมดอายุ
--     (expires_at = หมดอายุ session ของผู้เรียก + retention grace) แล้วค่อย reclaim/กวาด
--   * เขียน/อ่านโดย service client ฝั่ง server เท่านั้น — RLS + revoke กัน client เข้าถึง
--
-- ขอบเขตของ unique: เลือกระดับ organization ตามแผน §13 เพราะ atomicity ที่ต้องการคือ
-- "หนึ่งคีย์ execute ได้ครั้งเดียวต่อ org ข้ามทุก process/instance" (serverless หลาย instance);
-- ส่วน replay ยังผูก identity (store/user/session) ที่ store ตรวจเอง จึงไม่มีผลลัพธ์ไหลข้ามผู้ใช้
-- ============================================================

create table if not exists public.ai_assistant_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  -- user_id ไม่ใส่ FK ถึง auth.users: เป็น ledger ปฏิบัติการที่ถูกกวาดทิ้งตามอายุ (expires_at)
  -- การลบ user จึงไม่ต้องรอ sweep และ integration test ท้องถิ่นไม่ผูกกับข้อมูล auth
  user_id uuid not null,
  session_id text not null check (btrim(session_id) <> '' and char_length(session_id) <= 128),
  -- ตรงกับ envelope ของ dispatcher: [A-Za-z0-9_-] ยาว 1-128
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{1,128}$'),
  tool text not null check (btrim(tool) <> '' and char_length(tool) <= 80),
  -- sha256 hex ของ canonical({tool, args}) จาก dispatcher — ใช้ตัดสิน replay/conflict
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  -- ผลลัพธ์ของ tool หลังผ่าน Zod: {"ok":true,"data":...} หรือ {"ok":false,"code":"..."}
  result jsonb,
  created_at timestamptz not null default now(),
  -- หมดอายุ session ของผู้เรียก + retention grace — หลังเวลานี้กวาดทิ้งได้และคีย์ถูก reclaim ได้
  expires_at timestamptz not null,
  -- atomic claim ข้าม process: คีย์เดียวต่อ org มีได้แถวเดียว (ตามแผน §13)
  constraint ai_assistant_actions_org_key_unique unique (organization_id, idempotency_key)
);

-- กวาดของหมดอายุ (opportunistic sweep) ค้นด้วย expires_at เท่านั้น
create index if not exists ai_assistant_actions_expires_at_idx
  on public.ai_assistant_actions (expires_at);

-- ============================================================
-- RLS — เขียน/อ่านโดย service client ฝั่ง server เท่านั้น (ผลลัพธ์ tool เป็นข้อมูลภายใน)
-- ============================================================
alter table public.ai_assistant_actions enable row level security;

-- RLS org-scoped ตาม pattern ตารางอื่น (กันพลาดตอน grant สิทธิ์ใหม่ในอนาคต)
create policy "ai_assistant_actions: store member can read"
  on public.ai_assistant_actions for select
  using (store_id in (select auth_user_store_ids()));

-- วันนี้ไม่มีเส้นทางที่ client อ่าน/เขียนตารางนี้ตรง ๆ จึงเพิกถอนสิทธิ์ PostgREST ทั้งหมด
-- (เส้นทางจริงไปผ่าน service client ใน dispatcher เท่านั้น — เหมือน print_hub_device_tokens)
revoke all privileges on table public.ai_assistant_actions from anon, authenticated;

-- ============================================================
-- append-only เท่าที่ทำได้: อัปเดตได้เพียง pending -> completed/failed ครั้งเดียว
-- ห้ามแก้ identity/fingerprint ของ claim และห้ามย้อนแถวที่จบแล้ว (ลบเพื่อ retention ยังทำได้)
-- ============================================================
create or replace function public.ai_assistant_actions_guard_update()
returns trigger
language plpgsql
as $$
begin
  if old.status in ('completed', 'failed') then
    raise exception 'ai_assistant_actions: row % is final and cannot be modified', old.id;
  end if;
  if new.status not in ('completed', 'failed') then
    raise exception 'ai_assistant_actions: status can only move pending -> completed/failed';
  end if;
  if new.organization_id is distinct from old.organization_id
    or new.store_id is distinct from old.store_id
    or new.user_id is distinct from old.user_id
    or new.session_id is distinct from old.session_id
    or new.idempotency_key is distinct from old.idempotency_key
    or new.tool is distinct from old.tool
    or new.fingerprint is distinct from old.fingerprint then
    raise exception 'ai_assistant_actions: claim identity/fingerprint are immutable';
  end if;
  return new;
end;
$$;

create trigger ai_assistant_actions_guard_update
  before update on public.ai_assistant_actions
  for each row
  execute function public.ai_assistant_actions_guard_update();

comment on table public.ai_assistant_actions is
  'Ledger idempotency แบบ durable ของ AI Assistant — atomic claim ด้วย UNIQUE (organization_id, idempotency_key), replay ตัดสินจาก fingerprint + identity, แถวหมดอายุถูกกวาดตาม expires_at';
