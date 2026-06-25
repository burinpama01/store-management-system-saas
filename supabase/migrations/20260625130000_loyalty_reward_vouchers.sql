-- Loyalty reward vouchers:
--  * typed rewards (discount / product) with optional image and catalog product link
--  * redemption issues a one-time voucher code (auto random or manual base + random suffix)
--  * discount rewards auto-issue a single-use, 30-day coupon reusing the existing coupon flow
--  * product rewards keep a voucher code consumed at POS (Phase 2)
--  * POS coupon-code brute-force guard table

-- ============================================================
-- 1) loyalty_rewards: reward type, discount config, product link, image, code mode
-- ============================================================
alter table loyalty_rewards
  add column if not exists reward_type text not null default 'product',
  add column if not exists discount_kind text,
  add column if not exists discount_value numeric(12,2),
  add column if not exists reward_product_id uuid,
  add column if not exists image_url text,
  add column if not exists code_mode text not null default 'auto',
  add column if not exists manual_code text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loyalty_rewards_reward_type_check') then
    alter table loyalty_rewards add constraint loyalty_rewards_reward_type_check
      check (reward_type in ('discount', 'product'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_rewards_discount_kind_check') then
    alter table loyalty_rewards add constraint loyalty_rewards_discount_kind_check
      check (discount_kind is null or discount_kind in ('amount', 'percentage'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_rewards_discount_value_check') then
    alter table loyalty_rewards add constraint loyalty_rewards_discount_value_check
      check (discount_value is null or discount_value > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_rewards_code_mode_check') then
    alter table loyalty_rewards add constraint loyalty_rewards_code_mode_check
      check (code_mode in ('auto', 'manual'));
  end if;
  -- discount rewards must define how much they discount
  if not exists (select 1 from pg_constraint where conname = 'loyalty_rewards_discount_fields_check') then
    alter table loyalty_rewards add constraint loyalty_rewards_discount_fields_check
      check (
        reward_type <> 'discount'
        or (discount_kind is not null and discount_value is not null and discount_value > 0)
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_rewards_product_fkey') then
    alter table loyalty_rewards add constraint loyalty_rewards_product_fkey
      foreign key (reward_product_id) references products(id) on delete set null;
  end if;
end $$;

-- ============================================================
-- 2) loyalty_reward_redemptions: voucher fields
-- ============================================================
alter table loyalty_reward_redemptions
  add column if not exists voucher_code text,
  add column if not exists coupon_id uuid,
  add column if not exists expires_at timestamptz,
  add column if not exists used_at timestamptz,
  add column if not exists used_order_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loyalty_reward_redemptions_coupon_fkey') then
    alter table loyalty_reward_redemptions add constraint loyalty_reward_redemptions_coupon_fkey
      foreign key (coupon_id) references coupons(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'loyalty_reward_redemptions_order_fkey') then
    alter table loyalty_reward_redemptions add constraint loyalty_reward_redemptions_order_fkey
      foreign key (used_order_id) references orders(id) on delete set null;
  end if;
end $$;

create unique index if not exists loyalty_reward_redemptions_voucher_code_idx
  on loyalty_reward_redemptions(store_id, voucher_code)
  where voucher_code is not null;

create index if not exists loyalty_reward_redemptions_coupon_idx
  on loyalty_reward_redemptions(coupon_id)
  where coupon_id is not null;

-- ============================================================
-- 3) Voucher token generator (avoids visually confusing characters)
-- ============================================================
create or replace function gen_loyalty_voucher_token(p_len int default 6)
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; -- excludes 0 O 1 I L
  v_result text := '';
  i int;
begin
  for i in 1..greatest(p_len, 4) loop
    v_result := v_result || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_result;
end;
$$;

-- ============================================================
-- 4) redeem_loyalty_reward: now issues a voucher + (for discounts) a single-use coupon
--    Return type changes uuid -> jsonb, so drop first.
-- ============================================================
drop function if exists redeem_loyalty_reward(uuid, uuid, uuid, uuid, text);

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
      ends_at, max_redemptions, is_active
    ) values (
      p_organization_id, p_store_id, v_code, 'ของรางวัล: ' || v_reward.name,
      coalesce(v_reward.discount_kind, 'amount'), v_reward.discount_value, 0,
      v_expires, 1, true
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

revoke execute on function redeem_loyalty_reward(uuid, uuid, uuid, uuid, text) from public;
revoke execute on function redeem_loyalty_reward(uuid, uuid, uuid, uuid, text) from anon;
revoke execute on function redeem_loyalty_reward(uuid, uuid, uuid, uuid, text) from authenticated;
grant execute on function redeem_loyalty_reward(uuid, uuid, uuid, uuid, text) to service_role;

-- ============================================================
-- 5) When a reward's coupon is redeemed at POS, mark the voucher used
-- ============================================================
create or replace function sync_reward_voucher_on_coupon_redemption()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update loyalty_reward_redemptions
     set used_at = now(),
         used_order_id = new.order_id,
         status = 'fulfilled',
         fulfilled_at = now()
   where coupon_id = new.coupon_id
     and store_id = new.store_id
     and used_at is null;
  return new;
end;
$$;

drop trigger if exists coupon_redemptions_sync_reward_voucher on coupon_redemptions;
create trigger coupon_redemptions_sync_reward_voucher
  after insert on coupon_redemptions
  for each row execute function sync_reward_voucher_on_coupon_redemption();

-- ============================================================
-- 6) POS coupon-code brute-force guard
--    Only the service role (server actions) reads/writes this log.
-- ============================================================
create table if not exists pos_coupon_code_attempts (
  id              uuid primary key default uuid_generate_v4(),
  organization_id uuid references organizations(id) on delete cascade,
  store_id        uuid not null references stores(id) on delete cascade,
  user_id         uuid,
  code_normalized text,
  succeeded       boolean not null,
  created_at      timestamptz not null default now()
);

create index if not exists pos_coupon_code_attempts_store_time_idx
  on pos_coupon_code_attempts(store_id, created_at desc);

alter table pos_coupon_code_attempts enable row level security;
revoke all on table pos_coupon_code_attempts from anon;
revoke all on table pos_coupon_code_attempts from authenticated;
