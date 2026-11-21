-- OT เฉพาะวัน (แผน Plan/Scheduled OT Days Plan v1.html)
--   ot_mode: daily = แบบเดิม (คิด OT ทุกวันที่ทำเกินชั่วโมงปกติ) · scheduled = คิดเฉพาะวันใน store_ot_days
--   ot_overflow_pay: ชั่วโมงที่เกิน (เกินชั่วโมงปกติแต่ไม่ได้เป็น OT) ของพนักงานรายชั่วโมง
--     regular = จ่ายเรทปกติ (พฤติกรรมเดิม) · none = ไม่จ่าย
--   ค่าเริ่มต้น = พฤติกรรมเดิม → ร้านเดิมเงินเดือนไม่เปลี่ยน

alter table store_hr_settings
  add column if not exists ot_mode text not null default 'daily',
  add column if not exists ot_overflow_pay text not null default 'regular';
alter table store_hr_settings drop constraint if exists store_hr_settings_ot_mode_check;
alter table store_hr_settings add constraint store_hr_settings_ot_mode_check
  check (ot_mode in ('daily', 'scheduled') and ot_overflow_pay in ('regular', 'none'));

-- วันที่ให้ OT (โหมด scheduled) — 1 แถวต่อวันต่อสาขา
create table if not exists store_ot_days (
  id                 uuid primary key default uuid_generate_v4(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  store_id           uuid not null references stores(id) on delete cascade,
  date               date not null,
  cap_hours          numeric(5,2) not null check (cap_hours > 0 and cap_hours <= 12),
  -- null = ใช้ตัวคูณของร้าน (store_hr_settings.ot_multiplier)
  multiplier         numeric(5,2) check (multiplier is null or (multiplier >= 1 and multiplier <= 5)),
  -- พนักงานที่ได้ OT วันนั้น (ต้องมีอย่างน้อย 1 คน)
  user_ids           uuid[] not null check (cardinality(user_ids) > 0),
  note               text check (note is null or char_length(note) <= 120),
  -- ผู้บันทึกล่าสุด (แก้วันเดิม = แทนที่ทั้งแถว) · ประวัติทุกครั้งอยู่ใน system_event_logs (hr.ot-days)
  updated_by_user_id uuid not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (store_id, date)
);
create index if not exists store_ot_days_store_date_idx on store_ot_days(store_id, date);

-- ผูก store กับ organization ให้ตรงกัน (ISSUE-20261110-RLS-001)
do $$
begin
  alter table public.store_ot_days
    add constraint store_ot_days_store_org_fk
    foreign key (store_id, organization_id) references public.stores(id, organization_id) on delete cascade;
exception when duplicate_object then null;
end $$;

alter table store_ot_days enable row level security;
-- อ่าน: สมาชิกสาขา (พนักงานเห็นวันที่ร้านให้ OT ได้) · เขียน: ผ่าน service role หลัง server action
-- ตรวจสิทธิ์ attendance.manage + กฎย้อนหลัง 7 วัน/งวดที่จ่ายแล้วเท่านั้น (กฎนี้ทำใน RLS ไม่ได้ครบ)
drop policy if exists "store_ot_days: store member can read" on store_ot_days;
create policy "store_ot_days: store member can read" on store_ot_days for select
  using (store_id in (select auth_user_store_ids()));
