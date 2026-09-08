-- สถิติ/แดชบอร์ดแต้มลูกค้า
--
-- เดิม loyalty_ledger ถูกอ่านที่เดียวคือ "ประวัติแต้มรายคน" ร้านจึงตอบไม่ได้ว่า
-- เดือนนี้แจกแต้มไปเท่าไร ลูกค้าเอาไปใช้จริงกี่แต้ม และมีแต้มค้างในระบบเท่าไร
-- (ภาระผูกพันที่ร้านต้องจ่ายคืนในอนาคต) — เพิ่มฟังก์ชันรวมยอดฝั่ง DB
-- เพื่อไม่ต้องดึง ledger ทั้งร้านมานับใน Node
--
-- เครื่องหมายของ points_delta ตามที่ระบบเขียนจริง:
--   earn       = บวกเสมอ
--   redeem     = ลบเสมอ
--   reversal   = ได้ทั้งบวกและลบ (กลับรายการได้แต้ม = ลบ, กลับรายการใช้แต้ม = บวก)
--   adjustment = ได้ทั้งบวกและลบ (พนักงานปรับมือ)
-- จึงคืน earned/redeemed เป็นเลขบวกเพื่อแสดงผลตรง ๆ ส่วน reversal/adjustment คืนค่าสุทธิแบบมีเครื่องหมาย
--
-- ขอบเขตช่วงเวลาเป็น timestamptz ที่ฝั่งแอปแปลงจากวันที่ตามโซนเวลาร้านมาแล้ว
-- (getStoreLocalDateRangeUtc) ส่วน p_timezone ใช้เฉพาะตอนแบ่งกลุ่ม "รายวัน"
-- ให้ตกวันเดียวกับที่พนักงานเห็นหน้าร้าน

create index if not exists loyalty_ledger_store_created_idx
  on loyalty_ledger(store_id, created_at desc);

-- 1) สรุปรวมช่วงเวลา
create or replace function public.get_loyalty_points_summary(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  earned_points numeric,
  redeemed_points numeric,
  reversal_points numeric,
  adjustment_points numeric,
  net_points numeric,
  earn_count bigint,
  redeem_count bigint,
  reversal_count bigint,
  adjustment_count bigint,
  entry_count bigint,
  active_customer_count bigint
)
language sql
stable
security invoker
as $$
  select
    round(coalesce(sum(points_delta) filter (where type = 'earn'), 0), 2),
    round(coalesce(-sum(points_delta) filter (where type = 'redeem'), 0), 2),
    round(coalesce(sum(points_delta) filter (where type = 'reversal'), 0), 2),
    round(coalesce(sum(points_delta) filter (where type = 'adjustment'), 0), 2),
    round(coalesce(sum(points_delta), 0), 2),
    count(*) filter (where type = 'earn')::bigint,
    count(*) filter (where type = 'redeem')::bigint,
    count(*) filter (where type = 'reversal')::bigint,
    count(*) filter (where type = 'adjustment')::bigint,
    count(*)::bigint,
    count(distinct customer_id)::bigint
  from loyalty_ledger
  where store_id = p_store_id
    and created_at >= p_from
    and created_at < p_to;
$$;

-- 2) แยกรายวันตามโซนเวลาร้าน
create or replace function public.get_loyalty_points_daily(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_timezone text default 'Asia/Bangkok'
)
returns table (
  date date,
  earned_points numeric,
  redeemed_points numeric,
  reversal_points numeric,
  adjustment_points numeric,
  net_points numeric,
  entry_count bigint
)
language sql
stable
security invoker
as $$
  select
    (created_at at time zone p_timezone)::date as date,
    round(coalesce(sum(points_delta) filter (where type = 'earn'), 0), 2),
    round(coalesce(-sum(points_delta) filter (where type = 'redeem'), 0), 2),
    round(coalesce(sum(points_delta) filter (where type = 'reversal'), 0), 2),
    round(coalesce(sum(points_delta) filter (where type = 'adjustment'), 0), 2),
    round(coalesce(sum(points_delta), 0), 2),
    count(*)::bigint
  from loyalty_ledger
  where store_id = p_store_id
    and created_at >= p_from
    and created_at < p_to
  group by 1
  order by 1 desc;
$$;

-- 3) ลูกค้าที่เคลื่อนไหวมากที่สุดในช่วงเวลา (พร้อมแต้มคงเหลือปัจจุบัน)
create or replace function public.get_loyalty_top_customers(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 10
)
returns table (
  customer_id uuid,
  customer_name text,
  phone text,
  earned_points numeric,
  redeemed_points numeric,
  net_points numeric,
  entry_count bigint,
  points_balance numeric
)
language sql
stable
security invoker
as $$
  select
    l.customer_id,
    c.name,
    c.phone,
    round(coalesce(sum(l.points_delta) filter (where l.type = 'earn'), 0), 2),
    round(coalesce(-sum(l.points_delta) filter (where l.type = 'redeem'), 0), 2),
    round(coalesce(sum(l.points_delta), 0), 2),
    count(*)::bigint,
    round(coalesce(max(a.points_balance), 0), 2)
  from loyalty_ledger l
  join customers c
    on c.id = l.customer_id
   and c.store_id = l.store_id
  left join loyalty_accounts a
    on a.customer_id = l.customer_id
   and a.store_id = l.store_id
  where l.store_id = p_store_id
    and l.created_at >= p_from
    and l.created_at < p_to
  group by l.customer_id, c.name, c.phone
  order by round(coalesce(sum(l.points_delta) filter (where l.type = 'earn'), 0), 2) desc,
           count(*) desc
  limit greatest(least(coalesce(p_limit, 10), 50), 1);
$$;

-- 4) แต้มคงค้างทั้งร้าน ณ ปัจจุบัน (ภาระผูกพันที่ยังไม่ถูกใช้)
create or replace function public.get_loyalty_points_outstanding(
  p_store_id uuid
)
returns table (
  outstanding_points numeric,
  member_count bigint,
  members_with_points bigint
)
language sql
stable
security invoker
as $$
  select
    round(coalesce(sum(points_balance), 0), 2),
    count(*)::bigint,
    count(*) filter (where points_balance > 0)::bigint
  from loyalty_accounts
  where store_id = p_store_id;
$$;

grant execute on function public.get_loyalty_points_summary(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_loyalty_points_daily(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.get_loyalty_top_customers(uuid, timestamptz, timestamptz, integer) to authenticated;
grant execute on function public.get_loyalty_points_outstanding(uuid) to authenticated;
