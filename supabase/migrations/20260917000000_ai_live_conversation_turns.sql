-- ============================================================
-- AI Live — บันทึกบทสนทนาไว้วิเคราะห์ (2026-09-17)
--
-- ทำไม: หน้าร้านเจอ "ผู้ช่วยถามตัวเลือกวนไม่จบ" แต่ log เดิมเก็บแค่ metadata (ชื่อ tool/ผลลัพธ์)
-- ไม่มีคำที่พนักงานพูด คำตอบของผู้ช่วย หรือ args ที่ model ส่งมา จึงวิเคราะห์ต้นเหตุจาก log ไม่ได้
--
-- หนึ่งแถว = หนึ่งจังหวะของบทสนทนา:
--   role = 'user'      ข้อความถอดเสียงของผู้พูด (จาก provider)
--   role = 'assistant' ข้อความที่ผู้ช่วยพูดออกไป (transcript ของเสียงตอบ)
--   role = 'tool'      tool ที่ model เรียก + args + ผลที่ระบบตอบกลับ (บันทึกจาก server เอง)
--
-- ความเป็นส่วนตัว: เปิดเก็บเฉพาะเมื่อ env AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED=true (ช่วงทดสอบ)
-- และทุกแถวมี expires_at (ค่าเริ่มต้น 30 วัน) — server กวาดแถวหมดอายุทิ้งเป็นระยะ
-- เขียน/อ่านผ่าน service client ฝั่ง server เท่านั้น (เหมือน ai_assistant_actions)
-- ============================================================

create table if not exists public.ai_live_conversation_turns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  store_id uuid not null references public.stores (id) on delete cascade,
  -- ไม่ผูก FK กับ auth.users: เป็นข้อมูลวิเคราะห์ที่หมดอายุเอง (แนวเดียวกับ ai_assistant_actions)
  user_id uuid not null,
  session_id text not null check (btrim(session_id) <> '' and char_length(session_id) <= 128),
  role text not null check (role in ('user', 'assistant', 'tool')),
  -- ลำดับในเซสชันจากฝั่งเครื่อง (ข้อความมาถึง server ไม่เรียงกันเสมอ) — null = ไม่ทราบ
  client_seq integer check (client_seq is null or client_seq >= 0),
  content text not null check (char_length(content) <= 4000),
  -- tool ที่ถูกเรียก (เฉพาะ role = 'tool')
  tool text check (tool is null or char_length(tool) <= 80),
  -- id ของ item/call จาก provider — กันบันทึกซ้ำเมื่อ browser ส่งซ้ำ
  provider_item_id text check (provider_item_id is null or char_length(provider_item_id) <= 128),
  -- ผลของ tool/รายละเอียดเสริม (ไม่ใช่ความลับ)
  metadata jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists ai_live_conversation_turns_session_idx
  on public.ai_live_conversation_turns (organization_id, session_id, created_at);

create index if not exists ai_live_conversation_turns_store_created_idx
  on public.ai_live_conversation_turns (store_id, created_at desc);

create index if not exists ai_live_conversation_turns_expires_at_idx
  on public.ai_live_conversation_turns (expires_at);

-- browser ส่งซ้ำ (retry) ต้องไม่ได้แถวซ้ำ
create unique index if not exists ai_live_conversation_turns_item_unique
  on public.ai_live_conversation_turns (session_id, role, provider_item_id)
  where provider_item_id is not null;

-- ============================================================
-- RLS — วันนี้ไม่มีเส้นทางที่ client อ่าน/เขียนตรง ๆ
-- ============================================================
alter table public.ai_live_conversation_turns enable row level security;

revoke all privileges on table public.ai_live_conversation_turns from anon, authenticated;

comment on table public.ai_live_conversation_turns is
  'AI Live conversation transcripts for analysis (opt-in via AI_ASSISTANT_LIVE_TRANSCRIPTS_ENABLED, expires_at retention). Service role only.';
