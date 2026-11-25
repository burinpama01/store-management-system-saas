-- โบนัสยอดขายรายวันในวันให้ OT: คนที่ออกก่อนจบช่วง OT ได้โบนัสตามยอด "ตอนที่ตัวเองออกงาน"
-- ยอดขายของวันทำการ (business date แบบเดียวกับ payroll_store_daily_sales) นับถึงเวลาที่กำหนด
-- รับหลายจุดตัดพร้อมกัน (วัน, เวลา) จับคู่ตามลำดับ → คืน idx (1-based) + ยอดสะสม
create or replace function public.payroll_store_sales_until(
  p_store_id uuid,
  p_dates date[],
  p_untils timestamptz[],
  p_channels text[]
)
returns table (idx integer, total numeric)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select coalesce(s.timezone, 'Asia/Bangkok') as tz,
           coalesce(public.payroll_business_day_offset(s.id), interval '0') as off
      from stores s where s.id = p_store_id
  ),
  c as (
    select u.d, u.t, u.i
      from unnest(p_dates, p_untils) with ordinality as u(d, t, i)
  )
  select c.i::integer as idx,
         coalesce(round(sum(o.total), 2), 0) as total
    from c
    cross join cfg
    left join orders o
      on o.store_id = p_store_id
     and o.status = 'paid'
     and o.paid_at >= ((c.d::timestamp + cfg.off) at time zone cfg.tz)
     and o.paid_at <  (((c.d + 1)::timestamp + cfg.off) at time zone cfg.tz)
     and o.paid_at <= c.t
     and (case
            when o.qr_order_source then 'qr'
            when o.order_number like 'JDC-%' then 'delivery'
            else 'pos'
          end) = any(p_channels)
   group by c.i
   order by c.i;
$$;

revoke all on function public.payroll_store_sales_until(uuid, date[], timestamptz[], text[]) from public, anon, authenticated;
grant execute on function public.payroll_store_sales_until(uuid, date[], timestamptz[], text[]) to service_role;
