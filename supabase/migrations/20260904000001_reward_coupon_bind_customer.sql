-- ============================================================
-- ผูกคูปองที่ได้จากการแลกแต้มเข้ากับลูกค้าผู้แลก (audit ข้อ 13)
--
-- ปัญหา: redeem_loyalty_reward สร้างคูปองโดยไม่ใส่ customer_ids เลย ทำให้เป็น bearer code
-- ใครก็ตามที่เห็นรหัส (บนจอลูกค้า ในใบเสร็จ หรือแคปหน้าจอส่งต่อ) เอาไปใช้ได้
-- ทั้งที่แต้มถูกหักจากบัญชีของอีกคนไปแล้ว
--
-- แก้จุดเดียว: เพิ่ม customer_ids = array[p_customer_id] ตอน insert coupons
-- ส่วนอื่นของฟังก์ชันคัดลอกมาเหมือนเดิมทุกตัวอักษร (เทียบ pg_get_functiondef กับ
-- migration 20260625130000 บน prod แล้วว่าตรงกัน ก่อนแก้)
--
-- ด่านบังคับใช้มีอยู่แล้วทั้งสองเส้นทางชำระเงิน:
--   20260621022000 (grocery) และ 20260621040000 (POS ปกติ) เช็ค
--   p_customer_id = any(v_coupon.customer_ids) อยู่แล้ว จึงไม่ต้องแก้เพิ่ม
--
-- หมายเหตุ: คูปองที่ออกไปแล้วก่อน migration นี้ยังเป็น bearer ตามเดิม (ไม่ไล่แก้ย้อนหลัง
-- เพราะจะทำให้คูปองที่ลูกค้าถืออยู่ใช้ไม่ได้กะทันหัน) — จะหมดอายุเองใน 30 วัน
-- ============================================================

create or replace function redeem_loyalty_reward(
  p_organization_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_reward_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account loyalty_accounts%rowtype;
  v_reward loyalty_rewards%rowtype;
  v_redemption_id uuid;
  v_coupon_id uuid := null;
  v_code text;
  v_base text := '';
  v_expires timestamptz := now() + interval '30 days';
  v_try int := 0;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'idempotency key ไม่ถูกต้อง';
  end if;
  if not exists (
    select 1 from customers
     where id = p_customer_id
       and organization_id = p_organization_id
       and store_id = p_store_id
       and is_active = true
  ) then
    raise exception 'ไม่พบสมาชิกที่ใช้งาน';
  end if;

  select *
    into v_reward
    from loyalty_rewards
   where id = p_reward_id
     and organization_id = p_organization_id
     and store_id = p_store_id
     and is_active = true
   for update;
  if not found then
    raise exception 'ไม่พบของรางวัล';
  end if;
  if v_reward.stock_quantity is not null and v_reward.stock_quantity <= 0 then
    raise exception 'ของรางวัลหมด';
  end if;

  insert into loyalty_accounts (organization_id, store_id, customer_id)
  values (p_organization_id, p_store_id, p_customer_id)
  on conflict (store_id, customer_id) do update
    set updated_at = now()
  returning * into v_account;

  select *
    into v_account
    from loyalty_accounts
   where id = v_account.id
   for update;

  if v_account.points_balance < v_reward.points_cost then
    raise exception 'แต้มไม่พอแลกของรางวัล';
  end if;

  update loyalty_accounts
     set points_balance = points_balance - v_reward.points_cost,
         updated_at = now()
   where id = v_account.id;

  if v_reward.stock_quantity is not null then
    update loyalty_rewards
       set stock_quantity = stock_quantity - 1,
           updated_at = now()
     where id = v_reward.id;
  end if;

  -- voucher code: manual base keeps an unpredictable random suffix so single-use
  -- codes never collide and cannot be guessed by counting up.
  if v_reward.code_mode = 'manual' and coalesce(trim(v_reward.manual_code), '') <> '' then
    v_base := normalize_coupon_code(v_reward.manual_code);
  end if;

  loop
    v_try := v_try + 1;
    if v_base <> '' then
      v_code := v_base || '-' || gen_loyalty_voucher_token(4);
    else
      v_code := gen_loyalty_voucher_token(6);
    end if;
    exit when not exists (
      select 1 from coupons
       where store_id = p_store_id and normalized_code = normalize_coupon_code(v_code)
    ) and not exists (
      select 1 from loyalty_reward_redemptions
       where store_id = p_store_id and voucher_code = v_code
    );
    if v_try >= 25 then
      raise exception 'ไม่สามารถสร้างรหัสแลกรับได้ กรุณาลองใหม่';
    end if;
  end loop;

  -- discount reward -> issue a single-use, 30-day coupon (reuses existing POS coupon flow)
  if v_reward.reward_type = 'discount' then
    insert into coupons (
      organization_id, store_id, code, name,
      discount_type, discount_value, min_subtotal,
      ends_at, max_redemptions, is_active, customer_ids
    ) values (
      p_organization_id, p_store_id, v_code, 'ของรางวัล: ' || v_reward.name,
      coalesce(v_reward.discount_kind, 'amount'), v_reward.discount_value, 0,
      v_expires, 1, true,
      -- ผูกคูปองกับผู้แลกเท่านั้น (audit ข้อ 13): เดิม customer_ids ว่าง = bearer code
      -- ใครเห็นรหัสบนจอ/ใบเสร็จก็เอาไปใช้แทนเจ้าของแต้มได้ ทั้งที่แต้มถูกหักจากคนอื่นไปแล้ว
      -- ด่านตรวจมีอยู่แล้วใน apply_pos_coupon / grocery checkout (เช็ค p_customer_id = any(customer_ids))
      array[p_customer_id]
    )
    returning id into v_coupon_id;
  end if;

  insert into loyalty_reward_redemptions (
    organization_id, store_id, reward_id, account_id, customer_id,
    points_spent, idempotency_key, voucher_code, coupon_id, expires_at, status
  ) values (
    p_organization_id, p_store_id, v_reward.id, v_account.id, p_customer_id,
    v_reward.points_cost, p_idempotency_key, v_code, v_coupon_id, v_expires, 'pending'
  )
  returning id into v_redemption_id;

  insert into loyalty_ledger (
    organization_id, store_id, account_id, customer_id,
    type, points_delta, reason, idempotency_key
  ) values (
    p_organization_id, p_store_id, v_account.id, p_customer_id,
    'redeem', -v_reward.points_cost, 'แลกของรางวัล: ' || v_reward.name, p_idempotency_key || ':ledger'
  );

  return jsonb_build_object(
    'redemption_id', v_redemption_id,
    'voucher_code', v_code,
    'reward_type', v_reward.reward_type,
    'reward_name', v_reward.name,
    'discount_kind', v_reward.discount_kind,
    'discount_value', v_reward.discount_value,
    'expires_at', v_expires
  );
end;
$$;
