-- ============================================================
-- AI Assistant durable session / terminal registry (P0 ของแผน Back Office AI Operator)
--
-- ทำไม: session store เดิม (src/modules/ai-assistant/session.ts) เก็บใน "หน่วยความจำของ
-- process เดียว" และคีย์ด้วย (organization, store, user) เท่านั้น ซึ่งพังสองทางบน production:
--
--   1. serverless สร้าง instance ใหม่บ่อย — คำสั่งถัดไปของคนเดิมอาจตกคนละ instance
--      แล้วได้ session ใหม่ ⇒ replay โดน IDEMPOTENCY_CONFLICT (fail-closed แต่ผู้ใช้เห็นว่า
--      "สั่งแล้วไม่ทำงาน") และ cart binding ที่ผูกไว้หายไป
--   2. หนึ่ง user = หนึ่ง session ⇒ เปิดสองแท็บ แท็บที่สองผูกตะกร้าคนละใบไม่ได้
--      (session ผูกตะกร้าได้ใบเดียวตลอดอายุ) จึงโดน CONTEXT_UNAVAILABLE
--      งานหลังร้านคนเปิดหลายแท็บเป็นเรื่องปกติ ข้อนี้จึงบล็อกการเปิด mutation จริง
--
-- แก้ด้วยการย้าย session ลง DB และเพิ่มมิติ device (เครื่อง/แท็บ) เข้าไปในคีย์:
--   * UNIQUE (organization_id, store_id, user_id, device_id) = หนึ่ง session ต่อ "เครื่อง"
--     ⇒ หลายแท็บ/หลายเครื่องของคนเดียวกันแยก session และแยก cart binding ได้
--   * session_id UNIQUE ทั้งตาราง — ตัวที่ idempotency ledger อ้างถึง
--   * อยู่รอดข้าม instance/restart ⇒ replay ทำงานตามที่ออกแบบไว้จริง
--
-- cart binding ยังเป็นกติกาเดิมทุกข้อ (ผูกใบเดียวตลอดอายุ, version ห้ามย้อนหลัง)
-- แต่ย้ายการบังคับมาไว้ที่ UPDATE แบบมีเงื่อนไขในคำสั่งเดียว จึง atomic ข้าม process
-- (ของเดิมเป็น check-then-set ในหน่วยความจำ ซึ่งปลอดภัยเพราะมี process เดียวเท่านั้น)
--
-- เขียน/อ่านโดย service client ฝั่ง server เท่านั้น — pattern เดียวกับ ai_assistant_actions
-- ============================================================

create table if not exists public.ai_assistant_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  -- user_id ไม่ใส่ FK ถึง auth.users ด้วยเหตุผลเดียวกับ ai_assistant_actions:
  -- เป็นข้อมูลปฏิบัติการที่ถูกกวาดตาม expires_at อยู่แล้ว
  user_id uuid not null,
  -- ตัวระบุ "เครื่อง/แท็บ" ที่ client สร้างและเก็บไว้เอง (opaque ห้ามมีความหมายอื่น)
  -- รูปแบบตรงกับ ACTIVE_CART_ID_PATTERN ฝั่งโค้ดเพื่อให้ตรวจที่เดียวกันทั้งสองฝั่ง
  device_id text not null check (device_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  -- session id ที่ context/ledger อ้างถึง (uuid ที่ฝั่งโค้ดสร้าง)
  session_id text not null check (btrim(session_id) <> '' and char_length(session_id) <= 128),
  -- ตะกร้าที่ session นี้ผูกไว้ — null = ยังไม่เคยผูก, ผูกแล้วเปลี่ยนใบไม่ได้
  bound_cart_id text check (bound_cart_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  -- version ล่าสุดที่ผ่านการตรวจ — กัน replay ของคำสั่งที่เก่ากว่าสถานะที่เคยเห็น
  last_cart_version integer not null default 0 check (last_cart_version >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- หนึ่ง session ต่อหนึ่งเครื่องของหนึ่งผู้ใช้ในหนึ่งร้าน
  constraint ai_assistant_sessions_terminal_unique
    unique (organization_id, store_id, user_id, device_id),
  constraint ai_assistant_sessions_session_id_unique unique (session_id)
);

-- กวาดของหมดอายุ (opportunistic sweep) ค้นด้วย expires_at เท่านั้น
create index if not exists ai_assistant_sessions_expires_at_idx
  on public.ai_assistant_sessions (expires_at);

-- ============================================================
-- RLS — เส้นทางจริงไปผ่าน service client เท่านั้น
-- ============================================================
alter table public.ai_assistant_sessions enable row level security;

create policy "ai_assistant_sessions: store member can read"
  on public.ai_assistant_sessions for select
  using (store_id in (select auth_user_store_ids()));

revoke all privileges on table public.ai_assistant_sessions from anon, authenticated;

-- ============================================================
-- identity ของ session เปลี่ยนไม่ได้ และตะกร้าที่ผูกแล้วเปลี่ยนใบไม่ได้
--
-- ข้อหลังสำคัญกว่าที่เห็น: ถ้าเปลี่ยนใบกลาง session ได้ คำสั่งที่ค้างอยู่ในสายจะไป
-- ลงตะกร้าผิดใบโดยไม่มีใครรู้ — trigger จึงเป็นด่านสุดท้ายเผื่อมีเส้นทางเขียนใหม่ในอนาคต
-- ที่ลืมใส่เงื่อนไขใน WHERE
-- ============================================================
create or replace function public.ai_assistant_sessions_guard_update()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id
    or new.store_id is distinct from old.store_id
    or new.user_id is distinct from old.user_id
    or new.device_id is distinct from old.device_id
    or new.session_id is distinct from old.session_id
    or new.created_at is distinct from old.created_at then
    raise exception 'ai_assistant_sessions: session identity is immutable';
  end if;
  if old.bound_cart_id is not null and new.bound_cart_id is distinct from old.bound_cart_id then
    raise exception 'ai_assistant_sessions: bound cart cannot change within a session';
  end if;
  if new.last_cart_version < old.last_cart_version then
    raise exception 'ai_assistant_sessions: cart version cannot move backwards';
  end if;
  return new;
end;
$$;

create trigger ai_assistant_sessions_guard_update
  before update on public.ai_assistant_sessions
  for each row
  execute function public.ai_assistant_sessions_guard_update();

comment on table public.ai_assistant_sessions is
  'Session/terminal registry ของ AI Assistant — หนึ่ง session ต่อ (org, store, user, device) อยู่รอดข้าม instance/restart; cart binding ผูกใบเดียวตลอดอายุและ version ห้ามย้อนหลัง';
