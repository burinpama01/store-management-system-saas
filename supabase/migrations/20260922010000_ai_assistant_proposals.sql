-- ============================================================
-- AI Assistant proposals (P1 — ชั้นยืนยัน)
--
-- คำสั่งหลังร้านต้องให้คนเห็นสิ่งที่จะเปลี่ยนก่อนเสมอ ระหว่าง "เสนอ" กับ "ยืนยัน" มีคนละ
-- request คั่นอยู่ และบน serverless อาจคนละ instance — ข้อเสนอจึงต้องอยู่ใน DB
--
-- ที่เก็บแค่ args ที่ผ่าน Zod แล้ว + ลายนิ้วมือของ diff ที่ผู้ใช้เห็น ไม่เก็บตัว diff เอง
-- เพราะ commit จะ plan() ใหม่แล้วเทียบลายนิ้วมือ — ถ้าเก็บ diff ไว้แล้วเอามาใช้ตอน commit
-- เราจะเขียนทับด้วยภาพเก่าของโลกโดยไม่รู้ตัว ซึ่งเป็นสิ่งเดียวกับที่ชั้นนี้มีไว้กัน
--
-- consumed_at = ใช้ครั้งเดียว กดยืนยันรัวไม่ทำให้ทำงานสองรอบ
-- (idempotency key ยังกันอีกชั้น แต่ชั้นนี้กันตั้งแต่ก่อนถึง execute)
-- ============================================================

create table if not exists public.ai_assistant_proposals (
  id text primary key check (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  user_id uuid not null,
  session_id text not null check (btrim(session_id) <> '' and char_length(session_id) <= 128),
  tool text not null check (btrim(tool) <> '' and char_length(tool) <= 80),
  -- args ที่ผ่าน Zod ของ tool แล้ว — commit ใช้ชุดนี้ ไม่รับ args ใหม่จาก client
  args jsonb not null,
  -- sha256 hex ของ draft ที่ผู้ใช้เห็น (summary + changes + affectedCount + prerequisites)
  draft_fingerprint text not null check (draft_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists ai_assistant_proposals_expires_at_idx
  on public.ai_assistant_proposals (expires_at);

alter table public.ai_assistant_proposals enable row level security;

create policy "ai_assistant_proposals: store member can read"
  on public.ai_assistant_proposals for select
  using (store_id in (select auth_user_store_ids()));

revoke all privileges on table public.ai_assistant_proposals from anon, authenticated;

-- ============================================================
-- ข้อเสนอเปลี่ยนเนื้อหาไม่ได้ และใช้ได้ครั้งเดียว
--
-- ถ้าแก้ args/fingerprint ของข้อเสนอที่เสนอไปแล้วได้ การ์ดที่ผู้ใช้เห็นจะไม่ใช่สิ่งที่
-- จะเกิดขึ้นจริง ซึ่งทำลายเหตุผลทั้งหมดของชั้นนี้ — trigger เป็นด่านสุดท้าย
-- ============================================================
create or replace function public.ai_assistant_proposals_guard_update()
returns trigger
language plpgsql
as $$
begin
  if old.consumed_at is not null then
    raise exception 'ai_assistant_proposals: proposal % was already used', old.id;
  end if;
  if new.organization_id is distinct from old.organization_id
    or new.store_id is distinct from old.store_id
    or new.user_id is distinct from old.user_id
    or new.session_id is distinct from old.session_id
    or new.tool is distinct from old.tool
    or new.args is distinct from old.args
    or new.draft_fingerprint is distinct from old.draft_fingerprint
    or new.expires_at is distinct from old.expires_at then
    raise exception 'ai_assistant_proposals: proposal content is immutable';
  end if;
  return new;
end;
$$;

create trigger ai_assistant_proposals_guard_update
  before update on public.ai_assistant_proposals
  for each row
  execute function public.ai_assistant_proposals_guard_update();

comment on table public.ai_assistant_proposals is
  'ข้อเสนอรอยืนยันของ AI Assistant — เก็บ args ที่ผ่าน Zod และลายนิ้วมือของ diff ที่ผู้ใช้เห็น; commit จะ plan() ใหม่แล้วเทียบลายนิ้วมือ ไม่ใช้ diff เก่า และใช้ได้ครั้งเดียว (consumed_at)';
