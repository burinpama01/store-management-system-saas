-- รายงานเชิงลึก (/reports/insights): รวมยอดทั้งหน้าใน RPC เดียว
--   * security invoker → ใช้ RLS ของผู้เรียก (ต้นทุนจาก order_item_costs เห็นเฉพาะ manager ขึ้นไป)
--   * นับวันตามเวลาไทย (Asia/Bangkok) และเทียบกับช่วงก่อนหน้าความยาวเท่ากัน
--   * ยอดรวมเป็น numeric ใน Postgres ไม่ติดเพดาน 1,000 แถวของ PostgREST
--   * อ่านอย่างเดียว ไม่สร้างตาราง ไม่แก้ข้อมูล

create or replace function public.get_sales_insights(
  p_store_id uuid,
  p_date_from date,
  p_date_to date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_tz constant text := 'Asia/Bangkok';
  v_days integer;
  v_from timestamptz;
  v_to timestamptz;
  v_prev_from timestamptz;
  v_result jsonb;
begin
  if p_store_id is null or p_date_from is null or p_date_to is null then
    raise exception 'store และช่วงวันที่ต้องไม่ว่าง' using errcode = '22023';
  end if;
  if p_date_to < p_date_from then
    raise exception 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม' using errcode = '22023';
  end if;
  v_days := (p_date_to - p_date_from) + 1;
  if v_days > 366 then
    raise exception 'ช่วงรายงานยาวได้ไม่เกิน 366 วัน' using errcode = '22023';
  end if;

  v_from := p_date_from::timestamp at time zone v_tz;
  v_to := (p_date_to + 1)::timestamp at time zone v_tz;
  v_prev_from := (p_date_from - v_days)::timestamp at time zone v_tz;

  with
  ord as (
    select o.id, o.total, o.subtotal, o.discount, o.coupon_discount_amount, o.customer_id,
           o.qr_order_source, o.order_number,
           (o.paid_at at time zone v_tz) as local_at,
           o.paid_at >= v_from as is_current
      from orders o
     where o.store_id = p_store_id
       and o.status = 'paid'
       and o.paid_at >= v_prev_from
       and o.paid_at < v_to
  ),
  cur as (select * from ord where is_current),
  prev as (select * from ord where not is_current),
  item as (
    select oi.id, oi.order_id, oi.product_id, oi.product_name, oi.quantity, oi.total_price,
           oi.quantity * coalesce(oi.unit_quantity, 1) as base_qty,
           ord.is_current, ord.local_at
      from order_items oi
      join ord on ord.id = oi.order_id
     where oi.voided is not true
  ),
  item_cost as (
    select item.*,
           case when c.order_item_id is not null and (c.unit_cost is not null or coalesce(c.packaging_cost, 0) > 0)
                then (coalesce(c.unit_cost, 0) + coalesce(c.packaging_cost, 0)) * item.base_qty end as line_cost
      from item
      left join order_item_costs c on c.order_item_id = item.id
  ),
  prod as (
    select p.id, p.name, p.category_id, p.is_active, coalesce(cat.name, 'ไม่มีหมวด') as category_name
      from products p
      left join categories cat on cat.id = p.category_id
     where p.store_id = p_store_id
  ),
  summary_of as (
    select is_current,
           count(*)::int as orders,
           round(coalesce(sum(total), 0), 2) as revenue,
           round(coalesce(sum(coalesce(discount, 0) + coalesce(coupon_discount_amount, 0)), 0), 2) as discount,
           count(*) filter (where customer_id is not null)::int as member_orders
      from ord group by is_current
  ),
  items_of as (
    select is_current, coalesce(sum(quantity), 0)::numeric as items
      from item group by is_current
  ),
  product_rows as (
    select ic.product_id,
           coalesce(max(prod.name), max(ic.product_name)) as name,
           max(prod.category_id::text) as category_id,
           coalesce(max(prod.category_name), 'ไม่มีหมวด') as category_name,
           sum(ic.quantity) as qty,
           round(sum(ic.total_price), 2) as revenue,
           count(distinct ic.order_id)::int as orders,
           round(sum(ic.line_cost), 2) as cost,
           round(coalesce(sum(ic.total_price) filter (where ic.line_cost is not null), 0), 2) as costed_revenue
      from item_cost ic
      left join prod on prod.id = ic.product_id
     where ic.is_current
     group by ic.product_id
  ),
  prev_product_rows as (
    select product_id, sum(quantity) as qty, round(sum(total_price), 2) as revenue
      from item where not is_current group by product_id
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_date_from, 'to', p_date_to, 'days', v_days,
                                'prevFrom', p_date_from - v_days, 'prevTo', p_date_from - 1),
    'summary', (select jsonb_build_object('orders', coalesce(s.orders, 0), 'revenue', coalesce(s.revenue, 0),
                                          'discount', coalesce(s.discount, 0), 'memberOrders', coalesce(s.member_orders, 0),
                                          'items', coalesce((select items from items_of where is_current), 0))
                  from (select 1) x left join summary_of s on s.is_current),
    'prevSummary', (select jsonb_build_object('orders', coalesce(s.orders, 0), 'revenue', coalesce(s.revenue, 0),
                                              'discount', coalesce(s.discount, 0), 'memberOrders', coalesce(s.member_orders, 0),
                                              'items', coalesce((select items from items_of where not is_current), 0))
                      from (select 1) x left join summary_of s on not s.is_current),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'orders', n, 'revenue', r) order by d)
                         from (select local_at::date as d, count(*)::int n, round(sum(total), 2) r from cur group by 1) t), '[]'::jsonb),
    'hourly', coalesce((select jsonb_agg(jsonb_build_object('dow', dow, 'hour', h, 'orders', n, 'revenue', r))
                          from (select extract(isodow from local_at)::int dow, extract(hour from local_at)::int h,
                                       count(*)::int n, round(sum(total), 2) r
                                  from cur group by 1, 2) t), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
                             'productId', product_id, 'name', name, 'categoryId', category_id, 'categoryName', category_name,
                             'qty', qty, 'revenue', revenue, 'orders', orders, 'cost', cost, 'costedRevenue', costed_revenue)
                             order by revenue desc)
                            from product_rows), '[]'::jsonb),
    'prevProducts', coalesce((select jsonb_agg(jsonb_build_object('productId', product_id, 'qty', qty, 'revenue', revenue))
                                from prev_product_rows), '[]'::jsonb),
    'categoryDaily', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'categoryId', cid, 'categoryName', cname, 'revenue', r) order by d)
                                 from (select ic.local_at::date d, prod.category_id::text cid,
                                              coalesce(max(prod.category_name), 'ไม่มีหมวด') cname, round(sum(ic.total_price), 2) r
                                         from item ic left join prod on prod.id = ic.product_id
                                        where ic.is_current group by 1, 2) t), '[]'::jsonb),
    'channels', (select jsonb_build_object(
                    'pos', jsonb_build_object('orders', count(*) filter (where ch = 'pos'), 'revenue', coalesce(round(sum(total) filter (where ch = 'pos'), 2), 0)),
                    'qr', jsonb_build_object('orders', count(*) filter (where ch = 'qr'), 'revenue', coalesce(round(sum(total) filter (where ch = 'qr'), 2), 0)),
                    'delivery', jsonb_build_object('orders', count(*) filter (where ch = 'delivery'), 'revenue', coalesce(round(sum(total) filter (where ch = 'delivery'), 2), 0)))
                   from (select total,
                                case when qr_order_source is true then 'qr'
                                     when order_number like 'JDC-%' then 'delivery'
                                     else 'pos' end as ch
                           from cur) t),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'count', n, 'amount', a) order by a desc)
                            from (select pay.method, count(*)::int n, round(sum(pay.amount), 2) a
                                    from payments pay join cur on cur.id = pay.order_id
                                   where pay.status = 'completed'
                                   group by pay.method) t), '[]'::jsonb),
    'idleProducts', coalesce((select jsonb_agg(jsonb_build_object('productId', p.id, 'name', p.name, 'categoryName', p.category_name) order by p.name)
                                from (select prod.* from prod
                                       where prod.is_active
                                         and not exists (select 1 from item where item.is_current and item.product_id = prod.id)
                                       order by prod.name limit 100) p), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_sales_insights(uuid, date, date) from public, anon;
grant execute on function public.get_sales_insights(uuid, date, date) to authenticated;
