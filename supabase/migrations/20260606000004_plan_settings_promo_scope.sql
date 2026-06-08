-- #2 promotions scoped to a specific plan; #1 editable plan display config (landing).

alter table billing_promotions
  add column if not exists plan text
  check (plan is null or plan in ('starter','standard','premium'));

create table if not exists plan_settings (
  tier               text primary key check (tier in ('starter','standard','premium','enterprise')),
  display_name       text not null,
  visible_on_landing boolean not null default true,
  highlight          boolean not null default false,
  feature_lines      jsonb not null default '[]'::jsonb,
  sort_order         integer not null default 0,
  updated_at         timestamptz not null default now()
);

insert into plan_settings (tier, display_name, highlight, sort_order, feature_lines) values
  ('starter','Starter',false,1,'["POS พื้นฐาน","รายรับ-รายจ่าย","พิมพ์ใบเสร็จผ่าน Browser","ประวัติลูกค้า"]'::jsonb),
  ('standard','Standard',false,2,'["ทุกอย่างใน Starter","จัดการบุฟเฟต์","จัดการสต็อก","พิมพ์ Bluetooth/USB/IP"]'::jsonb),
  ('premium','Premium',true,3,'["ทุกอย่างใน Standard","QR Food Ordering","LINE Notify","ลงเวลา GPS + คอมมิชชั่น"]'::jsonb),
  ('enterprise','Enterprise',false,4,'["จัดการสาขาแบบศูนย์กลาง","รายงานรวมหลายสาขา","API Integration","Support พิเศษ"]'::jsonb)
on conflict (tier) do nothing;

-- Internal: read via service client (landing/pricing server components); no client policies.
alter table plan_settings enable row level security;
