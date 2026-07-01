-- Customer-initiated QR order cancellation. A customer may cancel their own QR
-- order only while the kitchen has not accepted it yet (prep_status = 'new').
-- QR orders deduct stock at creation, so cancellation restores it. Callable only
-- by the server (service_role) via the public cancel action.

create or replace function cancel_qr_order_by_customer(
  p_store_id uuid,
  p_table_id uuid,
  p_order_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_prep text;
  v_qr boolean;
begin
  select status, prep_status, qr_order_source
    into v_status, v_prep, v_qr
    from orders
   where id = p_order_id and store_id = p_store_id and table_id = p_table_id
   for update;
  if not found then
    raise exception 'ไม่พบออเดอร์';
  end if;
  if not coalesce(v_qr, false) then
    raise exception 'ยกเลิกได้เฉพาะออเดอร์ที่สั่งผ่าน QR';
  end if;
  if v_status <> 'open' then
    raise exception 'ออเดอร์นี้ยกเลิกไม่ได้';
  end if;
  if v_prep <> 'new' then
    raise exception 'ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้';
  end if;

  -- Restore the stock that was deducted when the QR order was created.
  update product_variants pv
     set stock_quantity = coalesce(pv.stock_quantity, 0) + oi.qty
  from (
    select variant_id, sum(quantity)::int as qty
      from order_items
     where order_id = p_order_id and variant_id is not null
     group by variant_id
  ) oi
  where pv.id = oi.variant_id and pv.track_stock = true;

  update orders set status = 'cancelled', updated_at = now() where id = p_order_id;
end;
$$;

revoke execute on function cancel_qr_order_by_customer(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function cancel_qr_order_by_customer(uuid, uuid, uuid) to service_role;
