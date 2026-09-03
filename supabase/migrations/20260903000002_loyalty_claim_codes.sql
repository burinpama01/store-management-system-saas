-- ============================================================
-- สะสมแต้มแบบรวดเร็ว: "QR รับแต้ม" ท้ายใบเสร็จ
--
-- ปัญหา: แต้มเข้าได้ทางเดียวคือแคชเชียร์ต้องค้นหาลูกค้าแล้วผูกกับบิล "ก่อน" เก็บเงิน
--        ช่วงลูกค้าเยอะจึงช้า และถ้าลืมผูก = แต้มหายถาวร (บิลที่จ่ายแล้วแก้ไม่ได้)
--
-- วิธี: บิลที่ยังไม่ผูกลูกค้า จะได้รหัสรับแต้ม 1 รหัสต่อ 1 บิล พิมพ์เป็น QR ท้ายใบเสร็จ
--       ลูกค้าสแกนเองแล้วกดรับ → แต้มเข้าบัญชีตัวเอง โดยแคชเชียร์ไม่ต้องทำอะไรเลย
--
-- กติกาที่ล็อกไว้ (ตามที่เจ้าของร้านเลือก):
--   • 1 บิลรับได้ครั้งเดียวเท่านั้น
--   • หมดอายุใน 7 วัน
--   • บิลที่ผูกลูกค้าไว้แล้ว (ได้แต้มไปแล้ว) จะไม่มีรหัส
--   • จำนวนแต้ม "ล็อกตอนออกใบเสร็จ" — คิดด้วยสูตรเดียวกับตอนจ่ายเงินปกติ
--     round(total * points_per_currency, 2) เพื่อไม่ให้ได้ไม่เท่ากันถ้าร้านแก้อัตราทีหลัง
-- ============================================================

create table if not exists public.loyalty_claim_codes (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations(id) on delete cascade,
  store_id                uuid not null references public.stores(id) on delete cascade,
  order_id                uuid not null unique references public.orders(id) on delete cascade,
  code                    text not null,
  -- แต้มที่จะได้ ล็อกไว้ตั้งแต่ตอนสร้างรหัส
  points                  numeric(12,2) not null check (points > 0),
  expires_at              timestamptz not null,
  claimed_at              timestamptz,
  claimed_by_customer_id  uuid references public.customers(id) on delete set null,
  created_at              timestamptz not null default now()
);

create unique index if not exists loyalty_claim_codes_store_code_unique
  on public.loyalty_claim_codes (store_id, code);

create index if not exists loyalty_claim_codes_store_unclaimed_idx
  on public.loyalty_claim_codes (store_id, claimed_at)
  where claimed_at is null;

alter table public.loyalty_claim_codes enable row level security;

-- อ่านได้เฉพาะคนในร้าน (ไว้ให้หน้าร้านตรวจย้อนหลังได้) — การเขียนทำผ่าน RPC เท่านั้น
create policy "loyalty_claim_codes: store member can read"
  on public.loyalty_claim_codes for select
  using (store_id in (select auth_user_store_ids()));

grant select on public.loyalty_claim_codes to authenticated;

-- ------------------------------------------------------------
-- สร้างรหัสรับแต้มของบิล (idempotent — เรียกซ้ำได้รหัสเดิม)
-- คืน null เมื่อบิลนี้ไม่ควรมีรหัส (ยังไม่จ่าย / ผูกลูกค้าแล้ว / ร้านปิดสะสมแต้ม / แต้มเป็น 0)
-- ------------------------------------------------------------
create or replace function public.create_loyalty_claim_code(
  p_store_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order orders%rowtype;
  v_settings loyalty_settings%rowtype;
  v_ppc numeric := 0;
  v_points numeric := 0;
  v_row loyalty_claim_codes%rowtype;
  v_code text;
begin
  select * into v_order
    from orders
   where id = p_order_id and store_id = p_store_id
   for update;
  if not found then
    return null;
  end if;

  -- มีรหัสอยู่แล้ว → คืนอันเดิม (ใบเสร็จพิมพ์ซ้ำต้องได้ QR เดิม)
  select * into v_row from loyalty_claim_codes where order_id = p_order_id;
  if found then
    return jsonb_build_object(
      'code', v_row.code,
      'points', v_row.points,
      'expires_at', v_row.expires_at,
      'claimed', v_row.claimed_at is not null
    );
  end if;

  if v_order.status <> 'paid' then return null; end if;
  if v_order.customer_id is not null then return null; end if;

  select * into v_settings
    from loyalty_settings
   where organization_id = v_order.organization_id and store_id = p_store_id;

  v_ppc := case
    when found and v_settings.earn_enabled is true then v_settings.points_per_currency
    when found then 0
    else 0.0100
  end;

  -- สูตรเดียวกับตอนจ่ายเงินปกติ (mirror 20260901000005 / 20260626140000)
  v_points := round(coalesce(v_order.total, 0) * v_ppc, 2);
  if v_points <= 0 then return null; end if;

  -- รหัสฐานสิบหก 8 ตัว — ไม่มีตัวอักษรที่สับสนกับเลข (ไม่มี O/I) และสั้นพอพิมพ์เองได้
  -- ใช้ gen_random_uuid() ที่มีมากับ Postgres (gen_random_bytes ต้องพึ่ง extension pgcrypto)
  loop
    v_code := upper(substr(gen_random_uuid()::text, 1, 8));
    exit when not exists (
      select 1 from loyalty_claim_codes where store_id = p_store_id and code = v_code
    );
  end loop;

  insert into loyalty_claim_codes (
    organization_id, store_id, order_id, code, points, expires_at
  )
  values (
    v_order.organization_id, p_store_id, p_order_id, v_code, v_points, now() + interval '7 days'
  )
  returning * into v_row;

  return jsonb_build_object(
    'code', v_row.code,
    'points', v_row.points,
    'expires_at', v_row.expires_at,
    'claimed', false
  );
end;
$$;

-- ------------------------------------------------------------
-- ลูกค้ากดรับแต้มจากรหัส — ต้องอยู่ใต้ lock และให้ได้ครั้งเดียวเท่านั้น
-- ------------------------------------------------------------
create or replace function public.claim_loyalty_points(
  p_store_id uuid,
  p_code text,
  p_customer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row loyalty_claim_codes%rowtype;
  v_order orders%rowtype;
  v_customer customers%rowtype;
  v_account loyalty_accounts%rowtype;
  v_ledger_id uuid;
begin
  select * into v_row
    from loyalty_claim_codes
   where store_id = p_store_id and code = upper(trim(p_code))
   for update;
  if not found then
    return jsonb_build_object('status', 'not_found', 'message', 'ไม่พบรหัสรับแต้มนี้');
  end if;

  if v_row.claimed_at is not null then
    return jsonb_build_object('status', 'already_claimed', 'message', 'บิลนี้ถูกรับแต้มไปแล้ว');
  end if;

  if v_row.expires_at <= now() then
    return jsonb_build_object('status', 'expired', 'message', 'รหัสรับแต้มหมดอายุแล้ว (รับได้ภายใน 7 วัน)');
  end if;

  select * into v_customer
    from customers
   where id = p_customer_id and store_id = p_store_id and is_active = true;
  if not found then
    return jsonb_build_object('status', 'invalid_customer', 'message', 'ไม่พบสมาชิกของร้านนี้');
  end if;

  select * into v_order from orders where id = v_row.order_id for update;
  if not found or v_order.status <> 'paid' then
    return jsonb_build_object('status', 'order_unavailable', 'message', 'บิลนี้ใช้รับแต้มไม่ได้แล้ว');
  end if;
  if v_order.customer_id is not null then
    return jsonb_build_object('status', 'already_claimed', 'message', 'บิลนี้ถูกรับแต้มไปแล้ว');
  end if;

  insert into loyalty_accounts (organization_id, store_id, customer_id)
  values (v_row.organization_id, p_store_id, p_customer_id)
  on conflict (store_id, customer_id) do update
    set updated_at = loyalty_accounts.updated_at
  returning * into v_account;

  insert into loyalty_ledger (
    organization_id, store_id, account_id, customer_id, order_id,
    type, points_delta, reason, idempotency_key
  )
  values (
    v_row.organization_id, p_store_id, v_account.id, p_customer_id, v_row.order_id,
    'earn', v_row.points, 'receipt_claim', 'claim:' || v_row.id::text
  )
  on conflict (store_id, idempotency_key) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    -- เคยลงบัญชีไปแล้ว (ไม่ควรเกิดใต้ lock) — ห้ามบวกซ้ำเด็ดขาด
    update loyalty_claim_codes
       set claimed_at = coalesce(claimed_at, now()), claimed_by_customer_id = coalesce(claimed_by_customer_id, p_customer_id)
     where id = v_row.id;
    return jsonb_build_object('status', 'already_claimed', 'message', 'บิลนี้ถูกรับแต้มไปแล้ว');
  end if;

  update loyalty_accounts
     set points_balance = points_balance + v_row.points,
         updated_at = now()
   where id = v_account.id;

  -- ผูกลูกค้ากับบิลย้อนหลัง ให้ประวัติบิลตรงกับที่ควรจะเป็นถ้าแคชเชียร์ผูกตั้งแต่แรก
  update orders
     set customer_id = p_customer_id,
         loyalty_points_earned = v_row.points,
         updated_at = now()
   where id = v_row.order_id;

  update loyalty_claim_codes
     set claimed_at = now(), claimed_by_customer_id = p_customer_id
   where id = v_row.id;

  return jsonb_build_object(
    'status', 'claimed',
    'points', v_row.points,
    'balance', v_account.points_balance + v_row.points,
    'order_number', v_order.order_number
  );
end;
$$;

revoke all on function public.create_loyalty_claim_code(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_loyalty_points(uuid, text, uuid) from public, anon, authenticated;

comment on table public.loyalty_claim_codes is
  'รหัสรับแต้มท้ายใบเสร็จ — 1 บิล 1 รหัส ใช้ได้ครั้งเดียวภายใน 7 วัน (แต้มล็อกตอนออกใบเสร็จ)';
