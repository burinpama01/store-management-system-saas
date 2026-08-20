-- แก้บั๊ก: ใช้ status='trialing' เป็นตัวชี้ "สิทธิ์ทดลองของโปรใหม่" ไม่ปลอดภัย
-- มีข้อมูลเก่าที่เป็น plan=enterprise + status=trialing + period_end หมดไปแล้ว
-- (ตั้งไว้ตอนที่โค้ดเดิมให้ enterprise ผ่านด่านบิลตลอด จึงไม่มีใครเห็นว่าหมดอายุ)
-- พอทำให้ enterprise/trialing หมดอายุได้ องค์กรนั้นถูกตัดสิทธิ์ทันทีทั้งองค์กร
--
-- ทางแก้: ทำเครื่องหมายเฉพาะของโปรลงบน subscription ตอนกดรับสิทธิ์
-- แถวเก่าที่ไม่มีเครื่องหมายนี้ = พฤติกรรมเดิมทุกอย่าง (ไม่ต้องแก้ข้อมูลย้อนหลัง)

alter table subscriptions
  add column if not exists promo_trial_code text;

comment on column subscriptions.promo_trial_code is
  'ตั้งค่าเมื่อ subscription นี้มาจากโปรทดลองฟรี (เช่น enterprise_free_30d_once); null = แพ็กเกจปกติ/สัญญา';

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

  -- promo_trial_code คือตัวชี้เดียวที่บอกว่า Enterprise ชุดนี้หมดอายุได้
  -- (status='trialing' อย่างเดียวเชื่อไม่ได้ — มีข้อมูลเก่าถือสถานะนี้อยู่)
  insert into subscriptions (
    organization_id,
    plan,
    status,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    trial_end,
    promo_trial_code,
    updated_at
  ) values (
    p_organization_id,
    'enterprise',
    'trialing',
    v_now,
    v_new_expiry,
    false,
    v_new_expiry,
    'enterprise_free_30d_once',
    v_now
  )
  on conflict (organization_id) do update
     set plan = excluded.plan,
         status = excluded.status,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         cancel_at_period_end = excluded.cancel_at_period_end,
         trial_end = excluded.trial_end,
         promo_trial_code = excluded.promo_trial_code,
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

revoke all on function claim_free_trial(uuid, uuid) from public, anon, authenticated;
grant execute on function claim_free_trial(uuid, uuid) to service_role;
