-- Aggregate report revenue in Postgres numeric space instead of JavaScript floats.

create or replace function public.get_report_sales_summary(
  p_store_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  order_count bigint,
  revenue numeric,
  avg_order_value numeric,
  qr_order_count bigint,
  pos_order_count bigint
)
language sql
stable
security invoker
as $$
  select
    count(*)::bigint as order_count,
    round(coalesce(sum(total), 0), 2) as revenue,
    round(coalesce(avg(total), 0), 2) as avg_order_value,
    count(*) filter (where qr_order_source is true)::bigint as qr_order_count,
    count(*) filter (where qr_order_source is not true)::bigint as pos_order_count
  from orders
  where store_id = p_store_id
    and status = 'paid'
    and paid_at >= p_date_from::timestamptz
    and paid_at < (p_date_to + 1)::timestamptz;
$$;

create or replace function public.get_report_daily_sales(
  p_store_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  date text,
  order_count bigint,
  revenue numeric
)
language sql
stable
security invoker
as $$
  select
    paid_at::date::text as date,
    count(*)::bigint as order_count,
    round(coalesce(sum(total), 0), 2) as revenue
  from orders
  where store_id = p_store_id
    and status = 'paid'
    and paid_at >= p_date_from::timestamptz
    and paid_at < (p_date_to + 1)::timestamptz
  group by paid_at::date
  order by paid_at::date;
$$;

grant execute on function public.get_report_sales_summary(uuid, date, date) to authenticated;
grant execute on function public.get_report_daily_sales(uuid, date, date) to authenticated;
