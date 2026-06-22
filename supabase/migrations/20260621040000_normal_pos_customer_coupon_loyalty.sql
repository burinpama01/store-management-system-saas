-- Shared customer/coupon checkout for the normal POS.
-- The normal POS keeps its table context, while reusing the same trusted
-- coupon reservation and loyalty-payment primitives as Grocery POS.

create table if not exists pos_order_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  idempotency_key text not null,
  order_id uuid not null references orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (store_id, idempotency_key)
);

alter table pos_order_idempotency_keys enable row level security;
revoke all on table pos_order_idempotency_keys from anon;
revoke all on table pos_order_idempotency_keys from authenticated;

create or replace function create_pos_order_with_customer_rewards(
  p_organization_id uuid,
  p_store_id uuid,
  p_order_number text,
  p_table_id uuid default null,
  p_table_number text default null,
  p_cashier_id uuid default null,
  p_customer_id uuid default null,
  p_coupon_id uuid default null,
  p_coupon_discount_amount numeric default 0,
  p_subtotal numeric default 0,
  p_discount numeric default 0,
  p_discount_note text default null,
  p_total numeric default 0,
  p_note text default null,
  p_items jsonb default '[]'::jsonb,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_coupon coupons%rowtype;
  v_coupon_redemption_count integer := 0;
  v_customer_coupon_count integer := 0;
  v_manual_discount numeric := 0;
  v_coupon_base numeric := 0;
  v_expected_coupon_discount numeric := 0;
  v_idempotency_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
begin
  if (p_customer_id is not null or p_coupon_id is not null) and v_idempotency_key is null then
    raise exception 'ต้องมี idempotency key สำหรับ POS customer/coupon checkout';
  end if;

  if v_idempotency_key is not null then
    perform pg_advisory_xact_lock(hashtext(p_store_id::text || ':' || v_idempotency_key));

    select order_id into v_order_id
      from pos_order_idempotency_keys
     where store_id = p_store_id
       and idempotency_key = v_idempotency_key;

    if v_order_id is not null then
      return v_order_id;
    end if;
  end if;

  if p_customer_id is not null and not exists (
    select 1 from customers
    where id = p_customer_id
      and organization_id = p_organization_id
      and store_id = p_store_id
      and is_active = true
  ) then
    raise exception 'ลูกค้าไม่ถูกต้อง';
  end if;

  v_order_id := create_pos_order_with_items(
    p_organization_id,
    p_store_id,
    p_order_number,
    p_table_id,
    p_table_number,
    p_cashier_id,
    p_subtotal,
    p_discount,
    p_discount_note,
    p_total,
    p_note,
    p_items
  );

  update orders
     set customer_id = p_customer_id
   where id = v_order_id
     and store_id = p_store_id;

  if v_idempotency_key is not null then
    insert into pos_order_idempotency_keys (
      organization_id,
      store_id,
      idempotency_key,
      order_id
    )
    values (
      p_organization_id,
      p_store_id,
      v_idempotency_key,
      v_order_id
    );
  end if;

  if p_coupon_id is not null then
    select *
      into v_coupon
      from coupons
     where id = p_coupon_id
       and organization_id = p_organization_id
       and store_id = p_store_id
     for update;

    if not found then
      raise exception 'คูปองไม่ถูกต้อง';
    end if;
    if v_coupon.is_active is not true then
      raise exception 'คูปองนี้ปิดใช้งานแล้ว';
    end if;
    if v_coupon.starts_at is not null and now() < v_coupon.starts_at then
      raise exception 'คูปองนี้ยังไม่เริ่มใช้งาน';
    end if;
    if v_coupon.ends_at is not null and now() > v_coupon.ends_at then
      raise exception 'คูปองนี้หมดอายุแล้ว';
    end if;
    if p_subtotal < v_coupon.min_subtotal then
      raise exception 'ยอดซื้อยังไม่ถึงขั้นต่ำของคูปอง';
    end if;

    v_manual_discount := round(coalesce(p_discount, 0) - coalesce(p_coupon_discount_amount, 0), 2);
    if v_manual_discount < 0 then
      raise exception 'ยอดส่วนลดคูปองไม่ถูกต้อง';
    end if;
    if v_manual_discount > 0 and v_coupon.stackable_with_manual_discount is not true then
      raise exception 'คูปองนี้ใช้ร่วมกับส่วนลดท้ายบิลไม่ได้';
    end if;

    v_coupon_base := greatest(0, p_subtotal - v_manual_discount);
    if v_coupon.discount_type = 'percentage' then
      if v_coupon.discount_value > 100 then
        raise exception 'มูลค่าคูปองไม่ถูกต้อง';
      end if;
      v_expected_coupon_discount := round(least(v_coupon_base, v_coupon_base * (v_coupon.discount_value / 100)), 2);
    elsif v_coupon.discount_type = 'amount' then
      v_expected_coupon_discount := round(least(v_coupon_base, v_coupon.discount_value), 2);
    else
      raise exception 'ประเภทคูปองไม่ถูกต้อง';
    end if;

    if p_coupon_discount_amount <= 0
      or p_coupon_discount_amount > p_discount
      or round(p_coupon_discount_amount, 2) is distinct from v_expected_coupon_discount then
      raise exception 'ยอดส่วนลดคูปองไม่ถูกต้อง';
    end if;
    if array_length(v_coupon.customer_ids, 1) is not null
      and (p_customer_id is null or not (p_customer_id = any(v_coupon.customer_ids))) then
      raise exception 'คูปองนี้ใช้ได้เฉพาะลูกค้าที่กำหนด';
    end if;

    select count(*)
      into v_coupon_redemption_count
      from coupon_redemptions
     where coupon_id = p_coupon_id
       and store_id = p_store_id
       and voided_at is null;
    if v_coupon.max_redemptions is not null
      and v_coupon_redemption_count >= v_coupon.max_redemptions then
      raise exception 'คูปองนี้ถูกใช้ครบจำนวนแล้ว';
    end if;

    if p_customer_id is not null then
      select count(*)
        into v_customer_coupon_count
        from coupon_redemptions
       where coupon_id = p_coupon_id
         and customer_id = p_customer_id
         and store_id = p_store_id
         and voided_at is null;
      if v_coupon.max_redemptions_per_customer is not null
        and v_customer_coupon_count >= v_coupon.max_redemptions_per_customer then
        raise exception 'ลูกค้าคนนี้ใช้คูปองครบจำนวนแล้ว';
      end if;
    end if;

    insert into coupon_redemptions (
      organization_id,
      store_id,
      coupon_id,
      customer_id,
      order_id,
      discount_amount,
      idempotency_key
    )
    values (
      p_organization_id,
      p_store_id,
      p_coupon_id,
      p_customer_id,
      v_order_id,
      p_coupon_discount_amount,
      v_idempotency_key || ':coupon'
    );

    update orders
       set coupon_id = p_coupon_id,
           coupon_discount_amount = p_coupon_discount_amount
     where id = v_order_id
       and store_id = p_store_id;
  end if;

  return v_order_id;
end;
$$;

revoke execute on function create_pos_order_with_customer_rewards(
  uuid, uuid, text, uuid, text, uuid, uuid, uuid, numeric, numeric, numeric, text, numeric, text, jsonb, text
) from public;
revoke execute on function create_pos_order_with_customer_rewards(
  uuid, uuid, text, uuid, text, uuid, uuid, uuid, numeric, numeric, numeric, text, numeric, text, jsonb, text
) from anon;
grant execute on function create_pos_order_with_customer_rewards(
  uuid, uuid, text, uuid, text, uuid, uuid, uuid, numeric, numeric, numeric, text, numeric, text, jsonb, text
) to authenticated;
