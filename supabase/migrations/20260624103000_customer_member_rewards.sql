-- Customer member portal, reward redemption, and coupon per-customer guards.

drop trigger if exists coupon_redemptions_customer_limit_guard on coupon_redemptions;
drop function if exists enforce_coupon_customer_limit();

alter table loyalty_ledger drop constraint if exists loyalty_ledger_type_check;
alter table loyalty_ledger add constraint loyalty_ledger_type_check
  check (type in ('earn', 'redeem', 'reversal', 'adjustment'));

create table if not exists loyalty_rewards (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  description text,
  points_cost integer not null check (points_cost > 0),
  stock_quantity integer check (stock_quantity is null or stock_quantity >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists loyalty_rewards_store_active_idx
  on loyalty_rewards(store_id, is_active, points_cost);

create table if not exists loyalty_reward_redemptions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  reward_id uuid not null references loyalty_rewards(id) on delete restrict,
  account_id uuid not null references loyalty_accounts(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  points_spent integer not null check (points_spent > 0),
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'cancelled')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz,
  unique (store_id, idempotency_key)
);

create index if not exists loyalty_reward_redemptions_customer_idx
  on loyalty_reward_redemptions(store_id, customer_id, created_at desc);
create index if not exists loyalty_reward_redemptions_reward_idx
  on loyalty_reward_redemptions(store_id, reward_id, created_at desc);

create table if not exists customer_member_portal_links (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  token text not null unique,
  label text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_member_portal_links_store_active_idx
  on customer_member_portal_links(store_id, is_active, created_at desc);

create table if not exists customer_member_otps (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  portal_link_id uuid not null references customer_member_portal_links(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  purpose text not null check (purpose in ('register', 'login')),
  phone text not null,
  email text,
  name text,
  code_hash text not null,
  attempts integer not null default 0 check (attempts >= 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists customer_member_otps_lookup_idx
  on customer_member_otps(store_id, phone, created_at desc);

create table if not exists customer_member_sessions (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references organizations(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  session_token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists customer_member_sessions_customer_idx
  on customer_member_sessions(store_id, customer_id, expires_at desc);

alter table loyalty_rewards enable row level security;
alter table loyalty_reward_redemptions enable row level security;
alter table customer_member_portal_links enable row level security;
alter table customer_member_otps enable row level security;
alter table customer_member_sessions enable row level security;

grant select on loyalty_rewards to authenticated;
grant insert, update, delete on loyalty_rewards to authenticated;
grant select on loyalty_reward_redemptions to authenticated;
grant select, insert, update on customer_member_portal_links to authenticated;
revoke all on table customer_member_otps from anon;
revoke all on table customer_member_otps from authenticated;
revoke all on table customer_member_sessions from anon;
revoke all on table customer_member_sessions from authenticated;

drop policy if exists "loyalty_rewards: store member can read" on loyalty_rewards;
create policy "loyalty_rewards: store member can read"
  on loyalty_rewards for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "loyalty_rewards: manager+ can write" on loyalty_rewards;
create policy "loyalty_rewards: manager+ can write"
  on loyalty_rewards for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

drop policy if exists "loyalty_reward_redemptions: store member can read" on loyalty_reward_redemptions;
create policy "loyalty_reward_redemptions: store member can read"
  on loyalty_reward_redemptions for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "customer_member_portal_links: store member can read" on customer_member_portal_links;
create policy "customer_member_portal_links: store member can read"
  on customer_member_portal_links for select
  using (store_id in (select auth_user_store_ids()));

drop policy if exists "customer_member_portal_links: manager+ can write" on customer_member_portal_links;
create policy "customer_member_portal_links: manager+ can write"
  on customer_member_portal_links for all
  using (auth_user_role_in_store(organization_id, store_id, 'manager'))
  with check (auth_user_role_in_store(organization_id, store_id, 'manager'));

create or replace function enforce_coupon_customer_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_per_customer integer;
  v_customer_count integer;
begin
  select max_redemptions_per_customer
    into v_max_per_customer
    from coupons
   where id = new.coupon_id
     and store_id = new.store_id;

  if v_max_per_customer is not null and new.customer_id is null then
    raise exception 'ต้องเลือกลูกค้าก่อนใช้คูปองที่จำกัดต่อคน';
  end if;

  if v_max_per_customer is not null then
    select count(*)
      into v_customer_count
      from coupon_redemptions
     where coupon_id = new.coupon_id
       and customer_id = new.customer_id
       and store_id = new.store_id
       and voided_at is null;

    if v_customer_count >= v_max_per_customer then
      raise exception 'ลูกค้าคนนี้ใช้คูปองครบจำนวนแล้ว';
    end if;
  end if;

  return new;
end;
$$;

create trigger coupon_redemptions_customer_limit_guard
  before insert on coupon_redemptions
  for each row execute function enforce_coupon_customer_limit();

create or replace function adjust_customer_loyalty_points(
  p_organization_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_points_delta integer,
  p_reason text default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account loyalty_accounts%rowtype;
  v_ledger_id uuid;
  v_idempotency_key text := coalesce(p_idempotency_key, 'manual:' || gen_random_uuid()::text);
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'ไม่มีสิทธิ์ปรับแต้มลูกค้า';
  end if;
  if p_points_delta = 0 then
    raise exception 'จำนวนแต้มต้องไม่เป็น 0';
  end if;
  if not exists (
    select 1 from customers
     where id = p_customer_id
       and organization_id = p_organization_id
       and store_id = p_store_id
       and is_active = true
  ) then
    raise exception 'ไม่พบลูกค้าที่ใช้งาน';
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

  if v_account.points_balance + p_points_delta < 0 then
    raise exception 'แต้มคงเหลือไม่พอ';
  end if;

  update loyalty_accounts
     set points_balance = points_balance + p_points_delta,
         updated_at = now()
   where id = v_account.id;

  insert into loyalty_ledger (
    organization_id,
    store_id,
    account_id,
    customer_id,
    type,
    points_delta,
    reason,
    idempotency_key
  )
  values (
    p_organization_id,
    p_store_id,
    v_account.id,
    p_customer_id,
    'adjustment',
    p_points_delta,
    nullif(trim(coalesce(p_reason, '')), ''),
    v_idempotency_key
  )
  returning id into v_ledger_id;

  return v_ledger_id;
end;
$$;

create or replace function redeem_loyalty_reward(
  p_organization_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_reward_id uuid,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account loyalty_accounts%rowtype;
  v_reward loyalty_rewards%rowtype;
  v_redemption_id uuid;
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

  insert into loyalty_reward_redemptions (
    organization_id,
    store_id,
    reward_id,
    account_id,
    customer_id,
    points_spent,
    idempotency_key
  )
  values (
    p_organization_id,
    p_store_id,
    v_reward.id,
    v_account.id,
    p_customer_id,
    v_reward.points_cost,
    p_idempotency_key
  )
  returning id into v_redemption_id;

  insert into loyalty_ledger (
    organization_id,
    store_id,
    account_id,
    customer_id,
    type,
    points_delta,
    reason,
    idempotency_key
  )
  values (
    p_organization_id,
    p_store_id,
    v_account.id,
    p_customer_id,
    'redeem',
    -v_reward.points_cost,
    'แลกของรางวัล: ' || v_reward.name,
    p_idempotency_key || ':ledger'
  );

  return v_redemption_id;
end;
$$;

revoke execute on function redeem_loyalty_reward(uuid, uuid, uuid, uuid, text) from anon;
revoke execute on function redeem_loyalty_reward(uuid, uuid, uuid, uuid, text) from authenticated;
grant execute on function redeem_loyalty_reward(uuid, uuid, uuid, uuid, text) to service_role;

revoke execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, integer, text, text) from public;
revoke execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, integer, text, text) from anon;
revoke execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, integer, text, text) from authenticated;
grant execute on function adjust_customer_loyalty_points(uuid, uuid, uuid, integer, text, text) to service_role;
