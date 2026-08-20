-- แอดมินเลือกได้ว่า Enterprise ของแต่ละร้านเป็น "จำกัดเวลา" หรือ "ไม่มีวันหมดอายุ"
--
-- default false = ไม่จำกัด → แถวเดิมทุกแถวพฤติกรรมเหมือนเดิมเป๊ะ
-- (สำคัญ: Each Other เป็นดีล enterprise ไม่มีวันหมดอายุ ห้ามถูกตัดสิทธิ์)
-- สิทธิ์ทดลองฟรี 30 วันถือเป็น "จำกัดเวลา" เสมอ

alter table subscriptions
  add column if not exists enterprise_limited boolean not null default false;

comment on column subscriptions.enterprise_limited is
  'true = Enterprise แบบจำกัดเวลา (หมดอายุตาม current_period_end); false = สัญญาไม่มีวันหมดอายุ';

-- สิทธิ์จากโปรทดลองคือแบบจำกัดเวลาเสมอ
update subscriptions
   set enterprise_limited = true
 where promo_trial_code is not null
   and enterprise_limited = false;

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

  insert into subscriptions (
    organization_id,
    plan,
    status,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    trial_end,
    promo_trial_code,
    enterprise_limited,
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
    true,
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
         enterprise_limited = excluded.enterprise_limited,
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
