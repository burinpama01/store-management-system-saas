-- เว็บไซต์ของร้าน · S1 เทศกาลไทย
--
-- - store_websites.festival_settings: ร้านเปิด "เปลี่ยนตามเทศกาลอัตโนมัติ", แสดงล่วงหน้ากี่วัน, ปิดบางเทศกาล, ข้อความทักทายเอง
-- - website_festival_dates: วันที่ของเทศกาลจันทรคติ/ปฏิทินจีนรายปี (เทศกาลวันคงที่คำนวณในโค้ด)
--   ใช้เฉพาะแถว verified = true — ซูเปอร์แอดมินตรวจกับปฏิทินราชการ/ปฏิทินจีนแล้วกดยืนยันที่ /system/website-festivals
--   seed ด้านล่าง: ตรุษจีน/ไหว้พระจันทร์ ยืนยันแล้ว (ปฏิทินจีนแน่นอน) · วันพระและเทศกาลอื่น "ร่าง" รอตรวจ
--   (ปีที่มีอธิกมาส วันพระเลื่อนเป็นเดือนถัดไป จึงไม่เดาเอง)

alter table public.store_websites
  add column if not exists festival_settings jsonb not null default '{"auto": false, "leadDays": 2, "disabled": [], "greetings": {}}'::jsonb;

create table if not exists public.website_festival_dates (
  festival_key text not null check (festival_key ~ '^[a-z0-9_]{2,40}$'),
  year integer not null check (year between 2024 and 2100),
  starts_on date not null,
  ends_on date not null,
  verified boolean not null default false,
  note text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (festival_key, year),
  check (ends_on >= starts_on and ends_on - starts_on <= 14)
);

alter table public.website_festival_dates enable row level security;
revoke all on table public.website_festival_dates from anon, authenticated;
-- อ่าน/เขียนผ่าน service client ฝั่ง server เท่านั้น (หน้าซูเปอร์แอดมินตรวจสิทธิ์ก่อน)

insert into public.website_festival_dates (festival_key, year, starts_on, ends_on, verified, note) values
  -- ปฏิทินจีน (ยืนยันแล้ว)
  ('chinese_new_year', 2027, '2027-02-05', '2027-02-08', true, 'วันตรุษ 6 ก.พ. 2570'),
  ('chinese_new_year', 2028, '2028-01-25', '2028-01-28', true, 'วันตรุษ 26 ม.ค. 2571'),
  ('mid_autumn', 2027, '2027-09-15', '2027-09-15', true, null),
  ('mid_autumn', 2028, '2028-10-03', '2028-10-03', true, null),
  -- ร่าง — ต้องตรวจกับปฏิทินก่อนกดยืนยัน
  ('loy_krathong', 2026, '2026-11-24', '2026-11-24', false, 'ร่าง: ตรวจกับปฏิทินราชการ'),
  ('loy_krathong', 2027, '2027-11-13', '2027-11-13', false, 'ร่าง'),
  ('loy_krathong', 2028, '2028-11-01', '2028-11-01', false, 'ร่าง'),
  ('makha_bucha', 2027, '2027-02-20', '2027-02-20', false, 'ร่าง'),
  ('makha_bucha', 2028, '2028-02-10', '2028-02-10', false, 'ร่าง'),
  ('visakha_bucha', 2027, '2027-05-20', '2027-05-20', false, 'ร่าง'),
  ('visakha_bucha', 2028, '2028-05-08', '2028-05-08', false, 'ร่าง'),
  ('asanha_bucha', 2027, '2027-07-18', '2027-07-18', false, 'ร่าง'),
  ('asanha_bucha', 2028, '2028-07-06', '2028-07-06', false, 'ร่าง'),
  ('khao_phansa', 2027, '2027-07-19', '2027-07-19', false, 'ร่าง'),
  ('khao_phansa', 2028, '2028-07-07', '2028-07-07', false, 'ร่าง'),
  ('ok_phansa', 2027, '2027-10-15', '2027-10-15', false, 'ร่าง'),
  ('ok_phansa', 2028, '2028-10-03', '2028-10-03', false, 'ร่าง'),
  ('vegetarian', 2027, '2027-10-01', '2027-10-09', false, 'ร่าง: 9 วันตามปฏิทินจีน'),
  ('vegetarian', 2028, '2028-09-19', '2028-09-27', false, 'ร่าง'),
  ('ghost_festival', 2027, '2027-08-16', '2027-08-16', false, 'ร่าง'),
  ('ghost_festival', 2028, '2028-09-03', '2028-09-03', false, 'ร่าง')
on conflict (festival_key, year) do nothing;
