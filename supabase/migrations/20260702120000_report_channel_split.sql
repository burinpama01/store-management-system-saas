-- #9 รายงานแยกช่องทางขาย: POS / QR / เดลิเวอรี (JDC)
-- ออเดอร์เดลิเวอรีจาก StoreOS Connect ใช้เลขบิลขึ้นต้น 'JDC-' (qr_order_source = false)
-- เปลี่ยน return type ของฟังก์ชันจึงต้อง drop ก่อนสร้างใหม่

drop function if exists public.get_report_sales_summary(uuid, date, date);

create function public.get_report_sales_summary(
  p_store_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  order_count bigint,
  revenue numeric,
  avg_order_value numeric,
  qr_order_count bigint,
  pos_order_count bigint,
  delivery_order_count bigint,
  qr_revenue numeric,
  pos_revenue numeric,
  delivery_revenue numeric
)
language sql
stable
security invoker
as $$
  select
    count(*)::bigint as order_count,
    round(coalesce(sum(total), 0), 2) as revenue,
    round(coalesce(avg(total), 0), 2) as avg_order_value,
    count(*) filter (
      where qr_order_source is true
    )::bigint as qr_order_count,
    count(*) filter (
      where qr_order_source is not true and coalesce(order_number, '') not like 'JDC-%'
    )::bigint as pos_order_count,
    count(*) filter (
      where qr_order_source is not true and order_number like 'JDC-%'
    )::bigint as delivery_order_count,
    round(coalesce(sum(total) filter (
      where qr_order_source is true
    ), 0), 2) as qr_revenue,
    round(coalesce(sum(total) filter (
      where qr_order_source is not true and coalesce(order_number, '') not like 'JDC-%'
    ), 0), 2) as pos_revenue,
    round(coalesce(sum(total) filter (
      where qr_order_source is not true and order_number like 'JDC-%'
    ), 0), 2) as delivery_revenue
  from orders
  where store_id = p_store_id
    and status = 'paid'
    and paid_at >= p_date_from::timestamptz
    and paid_at < (p_date_to + 1)::timestamptz;
$$;

grant execute on function public.get_report_sales_summary(uuid, date, date) to authenticated;
