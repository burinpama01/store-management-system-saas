-- Kitchen can reject a single QR order line (e.g. item out of stock) instead of
-- the whole order. Voiding a line restores its stock, recomputes the order total
-- from the remaining lines, and cancels the order if nothing is left.

alter table order_items
  add column if not exists voided boolean not null default false,
  add column if not exists voided_reason text;

create or replace function void_qr_order_item(
  p_store_id uuid,
  p_order_id uuid,
  p_item_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_status text;
  v_qr boolean;
  v_variant uuid;
  v_qty integer;
  v_remaining integer;
  v_subtotal numeric;
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;

  select organization_id, status, qr_order_source
    into v_org, v_status, v_qr
    from orders
   where id = p_order_id and store_id = p_store_id
   for update;
  if not found then
    raise exception 'ไม่พบออเดอร์';
  end if;
  if not auth_user_role_in_store(v_org, p_store_id, 'cashier') then
    raise exception 'ไม่มีสิทธิ์จัดการออเดอร์';
  end if;
  if not coalesce(v_qr, false) then
    raise exception 'เฉพาะออเดอร์ที่สั่งผ่าน QR';
  end if;
  if v_status <> 'open' then
    raise exception 'ออเดอร์นี้แก้ไขไม่ได้';
  end if;

  select variant_id, quantity
    into v_variant, v_qty
    from order_items
   where id = p_item_id and order_id = p_order_id and voided = false;
  if not found then
    raise exception 'ไม่พบรายการ';
  end if;

  -- Restore the stock deducted at order creation.
  if v_variant is not null then
    update product_variants
       set stock_quantity = coalesce(stock_quantity, 0) + v_qty
     where id = v_variant and track_stock = true;
  end if;

  update order_items
     set voided = true, voided_reason = p_reason
   where id = p_item_id;

  -- Recompute order totals from the remaining (non-voided) lines.
  select count(*), coalesce(sum(total_price), 0)
    into v_remaining, v_subtotal
    from order_items
   where order_id = p_order_id and voided = false;

  update orders
     set subtotal = round(v_subtotal, 2),
         total = round(v_subtotal, 2),
         updated_at = now()
   where id = p_order_id;

  -- Nothing left to make — cancel the whole order.
  if v_remaining = 0 then
    update orders set status = 'cancelled', updated_at = now() where id = p_order_id;
  end if;
end;
$$;

revoke execute on function void_qr_order_item(uuid, uuid, uuid, text) from public, anon;
grant execute on function void_qr_order_item(uuid, uuid, uuid, text) to authenticated;
