-- แคมเปญ "ทดลอง Enterprise ฟรี 30 วัน" (แทนโปร Premium ฟรี 30 วันเดิม)
-- 1) super-admin เปิด/ปิดแคมเปญ + กำหนดช่วงเวลาได้ที่ /system/pricing
-- 2) สิทธิ์ใช้ได้ครั้งเดียวตลอดกาลต่อผู้ใช้และต่อกิจการ (นับรวมคนที่เคยกดโปร Premium เดิม)
-- 3) สิทธิ์ที่ได้เป็น subscription plan=enterprise status=trialing ที่ "หมดอายุจริง" ใน 30 วัน

-- ── ช่วงเวลาแคมเปญ (singleton) ────────────────────────────────────────
alter table platform_settings
  add column if not exists free_trial_enabled    boolean not null default true,
  add column if not exists free_trial_starts_at  timestamptz,
  add column if not exists free_trial_ends_at    timestamptz;

-- ── ตารางสิทธิ์: เดิมล็อกไว้เฉพาะ premium/30d → เปิดรับ enterprise ด้วย ──
alter table billing_premium_trial_redemptions
  drop constraint if exists billing_premium_trial_redemptions_plan_check;
alter table billing_premium_trial_redemptions
  add constraint billing_premium_trial_redemptions_plan_check
  check (plan in ('premium', 'enterprise'));

-- สิทธิ์เดิม unique เป็น (id, promotion_code) → โค้ดโปรใหม่จะกดซ้ำได้
-- เปลี่ยนเป็น unique ต่อ user / ต่อ org ล้วน = ฟรีได้ครั้งเดียวตลอดกาล
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'billing_premium_trial_redemptions'::regclass
       and contype = 'u'
  loop
    execute format('alter table billing_premium_trial_redemptions drop constraint %I', c.conname);
  end loop;
end $$;

alter table billing_premium_trial_redemptions
  add constraint billing_premium_trial_redemptions_user_once unique (user_id);
alter table billing_premium_trial_redemptions
  add constraint billing_premium_trial_redemptions_org_once unique (organization_id);

-- ── RPC ใหม่: กดรับสิทธิ์ Enterprise ฟรี 30 วัน ────────────────────────
create or replace function claim_free_trial(
  p_organization_id uuid,
  p_user_id uuid
)
returns table(ok boolean, code text, new_expiry timestamptz)
language plpgsql
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_new_expiry timestamptz := now() + interval '30 days';
  v_current_end timestamptz;
  v_member_exists boolean;
  v_campaign_open boolean;
begin
  select exists (
    select 1
    from memberships
    where organization_id = p_organization_id
      and user_id = p_user_id
      and joined_at is not null
  ) into v_member_exists;

  if not v_member_exists then
    return query select false, 'not_member'::text, null::timestamptz;
    return;
  end if;

  -- แคมเปญจำกัดเวลา: ต้องเปิดอยู่ และ now อยู่ในช่วง (null = ไม่กำหนดขอบนั้น)
  select coalesce(free_trial_enabled, false)
         and (free_trial_starts_at is null or v_now >= free_trial_starts_at)
         and (free_trial_ends_at is null or v_now <= free_trial_ends_at)
    into v_campaign_open
    from platform_settings
   where id = 'singleton';

  if not coalesce(v_campaign_open, false) then
    return query select false, 'campaign_closed'::text, null::timestamptz;
    return;
  end if;

  select current_period_end
    into v_current_end
    from subscriptions
    where organization_id = p_organization_id
    for update;

  if v_current_end is not null and v_current_end > v_now then
    return query select false, 'active_subscription'::text, null::timestamptz;
    return;
  end if;

  begin
    insert into billing_premium_trial_redemptions (
      organization_id,
      user_id,
      promotion_code,
      plan,
      duration,
      amount_expected,
      amount_charged,
      redeemed_at
    ) values (
      p_organization_id,
      p_user_id,
      'enterprise_free_30d_once',
      'enterprise',
      '30d',
      0,
      0,
      v_now
    );
  exception
    when unique_violation then
      return query select false, 'already_redeemed'::text, null::timestamptz;
      return;
  end;

  -- status = 'trialing' คือสิ่งที่ทำให้ Enterprise ชุดนี้หมดอายุได้จริง
  -- (Enterprise แบบสัญญาใช้ status='active' + ไม่มีกำหนดหมดอายุ)
  insert into subscriptions (
    organization_id,
    plan,
    status,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    trial_end,
    updated_at
  ) values (
    p_organization_id,
    'enterprise',
    'trialing',
    v_now,
    v_new_expiry,
    false,
    v_new_expiry,
    v_now
  )
  on conflict (organization_id) do update
     set plan = excluded.plan,
         status = excluded.status,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         trial_end = excluded.trial_end,
         updated_at = excluded.updated_at;

  insert into audit_logs (
    organization_id,
    store_id,
    actor_user_id,
    target_user_id,
    action,
    reason
  ) values (
    p_organization_id,
    null,
    p_user_id,
    null,
    'subscription.enterprise_free_trial_claimed',
    'enterprise/30d ราคา 0 บาท ถึง ' || v_new_expiry::text
  );

  return query select true, 'claimed'::text, v_new_expiry;
end;
$$;

-- โปร Premium เดิมถูกแทนที่: คงชื่อฟังก์ชันไว้เป็น wrapper กันโค้ดรุ่นก่อน deploy พัง
create or replace function claim_premium_free_trial(
  p_organization_id uuid,
  p_user_id uuid
)
returns table(ok boolean, code text, new_expiry timestamptz)
language sql
set search_path = public
as $$
  select * from claim_free_trial(p_organization_id, p_user_id);
$$;

revoke all on function claim_free_trial(uuid, uuid) from public, anon, authenticated;
grant execute on function claim_free_trial(uuid, uuid) to service_role;
revoke all on function claim_premium_free_trial(uuid, uuid) from public, anon, authenticated;
grant execute on function claim_premium_free_trial(uuid, uuid) to service_role;
