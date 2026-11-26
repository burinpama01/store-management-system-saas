-- R2 แผน Online Delivery v3: คนส่งออเดอร์ออนไลน์ + รายได้พิเศษคนส่งเข้าเงินเดือนอัตโนมัติ
-- สวิตช์ปิดทุกร้านเป็นค่าเริ่มต้น

alter table public.store_online_order_settings
  add column if not exists rider_pay_enabled boolean not null default false,
  add column if not exists rider_pay_rate numeric(5,2) not null default 10
    check (rider_pay_rate >= 0 and rider_pay_rate <= 100),
  add column if not exists rider_pay_include_fee boolean not null default true;

-- คนส่ง + อัตรา/ยอดที่ล็อกไว้ ณ ตอนออกไปส่ง (ร้านเปลี่ยนตั้งค่าทีหลังไม่ย้อน)
alter table public.online_orders
  add column if not exists rider_user_id uuid,
  add column if not exists rider_name text check (rider_name is null or char_length(rider_name) <= 120),
  add column if not exists rider_assigned_at timestamptz,
  add column if not exists rider_pay_rate numeric(5,2),
  add column if not exists rider_pay_amount numeric(12,2) check (rider_pay_amount is null or rider_pay_amount >= 0);

create index if not exists online_orders_rider_idx on public.online_orders (store_id, rider_user_id) where rider_user_id is not null;

-- รายได้คนส่ง = แถว payroll_adjustments ชนิด delivery_pay (บวกเงินเดือนเหมือนโบนัส)
alter table public.payroll_adjustments drop constraint if exists payroll_adjustments_type_check;
alter table public.payroll_adjustments add constraint payroll_adjustments_type_check
  check (type in ('penalty','bonus','leave','absent','late','withholding_tax','delivery_pay'));

-- 1 ออเดอร์ = รายได้คนส่ง 1 แถวเท่านั้น (กดสำเร็จซ้ำ/สองเครื่องพร้อมกันไม่จ่ายซ้ำ)
alter table public.payroll_adjustments add column if not exists online_order_id uuid;
create unique index if not exists payroll_adjustments_online_order_uidx
  on public.payroll_adjustments (online_order_id) where online_order_id is not null;
