-- Premium 30-day free trial redemption guard.
-- Internal table: service-role server actions claim the offer; client roles have no write policy.

create table if not exists billing_premium_trial_redemptions (
  id               uuid primary key default uuid_generate_v4(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  promotion_code   text not null default 'premium_free_30d_once',
  plan             text not null check (plan = 'premium'),
  duration         text not null check (duration = '30d'),
  amount_expected  numeric(12,2) not null check (amount_expected >= 0),
  amount_charged   numeric(12,2) not null default 0 check (amount_charged = 0),
  redeemed_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (user_id, promotion_code),
  unique (organization_id, promotion_code)
);

create index if not exists billing_premium_trial_redemptions_org_idx
  on billing_premium_trial_redemptions(organization_id);

create index if not exists billing_premium_trial_redemptions_user_idx
  on billing_premium_trial_redemptions(user_id);

alter table billing_premium_trial_redemptions enable row level security;

create or replace function claim_premium_free_trial(
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
      'premium_free_30d_once',
      'premium',
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
    updated_at
  ) values (
    p_organization_id,
    'premium',
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
    'subscription.premium_free_trial_claimed',
    'premium/30d ราคา 0 บาท ถึง ' || v_new_expiry::text
  );

  return query select true, 'claimed'::text, v_new_expiry;
end;
$$;

revoke all on function claim_premium_free_trial(uuid, uuid) from public, anon, authenticated;
grant execute on function claim_premium_free_trial(uuid, uuid) to service_role;
