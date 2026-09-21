-- Beam platform billing; no store merchant credentials are shared.
alter table public.platform_settings drop constraint if exists platform_settings_billing_provider_check;
alter table public.platform_settings add constraint platform_settings_billing_provider_check check (billing_provider in ('promptpay','stripe','beam'));
alter table public.platform_settings
  add column beam_environment text not null default 'test' check (beam_environment in ('test','live')),
  add column beam_credentials_encrypted text,
  add column beam_fallback_enabled boolean not null default false,
  add column beam_fallback_account text;

create table public.platform_billing_orders (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id),
  submitted_by uuid not null references auth.users(id),
  plan text not null check (plan in ('starter','standard','premium','business')),
  duration text not null check (duration in ('30d','1y')),
  amount numeric(12,2) not null check (amount > 0),
  discount_code_id uuid references public.billing_discount_codes(id),
  discount_amount numeric(12,2) not null default 0,
  business_seats integer,
  business_stores integer,
  business_features jsonb not null default '[]',
  method text not null check (method in ('beam','slip')),
  environment text not null check (environment in ('test','live')),
  credentials_encrypted text,
  receiver_account text,
  qr_payload text,
  qr_image text,
  charge_id text unique,
  creation_attempted boolean not null default false,
  status text not null default 'creating' check (status in ('creating','pending','failed','paid','test_paid')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paid_at timestamptz,
  new_expiry timestamptz
);
create unique index platform_billing_one_pending on public.platform_billing_orders(organization_id) where status in ('creating','pending');
alter table public.platform_billing_orders enable row level security;
revoke all on public.platform_billing_orders from anon, authenticated;
grant all on public.platform_billing_orders to service_role;

-- The service verifies provider evidence. This function grants entitlement exactly once.
create function public.settle_platform_billing_order(p_order_id uuid, p_method text, p_ref text, p_amount numeric)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.platform_billing_orders%rowtype;
  expiry timestamptz;
begin
  select * into o from public.platform_billing_orders where id = p_order_id;
  if not found then raise exception 'order_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(o.organization_id::text, 21092026));
  select * into o from public.platform_billing_orders where id = p_order_id for update;
  if o.status in ('paid','test_paid') then
    return jsonb_build_object('status', o.status, 'new_expiry', o.new_expiry);
  end if;
  if o.method <> p_method or p_amount <> o.amount or p_amount is null or nullif(btrim(p_ref),'') is null then
    raise exception 'evidence_mismatch';
  end if;
  if p_method = 'beam' and (o.charge_id is null or o.charge_id <> p_ref) then raise exception 'charge_mismatch'; end if;
  if p_method = 'slip' and o.status <> 'pending' then raise exception 'slip_order_closed'; end if;
  if o.environment = 'test' then
    update public.platform_billing_orders set status = 'test_paid', paid_at = now() where id = o.id;
    return jsonb_build_object('status','test_paid','new_expiry',null);
  end if;
  -- A late successful Beam charge is still real money; fulfil it even after FAILED.
  -- Ref namespace separates Beam charges from bank slip identifiers.
  insert into public.payment_submissions(organization_id, plan, duration, amount_expected, verified_amount,
    slip_ref, status, submitted_by, discount_code_id, discount_amount, business_seats, business_stores, business_features, verified_at)
  values (o.organization_id,o.plan,o.duration,o.amount,p_amount,
    case when p_method='beam' then 'beam:'||p_ref else p_ref end,'verified',o.submitted_by,
    o.discount_code_id,o.discount_amount,o.business_seats,o.business_stores,o.business_features,now());
  select current_period_end into expiry from public.subscriptions where organization_id=o.organization_id for update;
  expiry := greatest(coalesce(expiry,now()),now()) + case when o.duration='1y' then interval '365 days' else interval '30 days' end;
  insert into public.subscriptions(organization_id,plan,status,current_period_start,current_period_end,cancel_at_period_end,
    trial_end,promo_trial_code,business_seats,business_stores,business_features,updated_at)
  values (o.organization_id,o.plan,'active',now(),expiry,false,null,null,o.business_seats,o.business_stores,o.business_features,now())
  on conflict(organization_id) do update set plan=excluded.plan,status='active',current_period_start=excluded.current_period_start,
    current_period_end=excluded.current_period_end,cancel_at_period_end=false,trial_end=null,promo_trial_code=null,
    business_seats=excluded.business_seats,business_stores=excluded.business_stores,business_features=excluded.business_features,updated_at=now();
  update public.platform_billing_orders set status='paid',paid_at=now(),new_expiry=expiry where id=o.id;
  insert into public.audit_logs(organization_id,actor_user_id,action,reason)
  values(o.organization_id,o.submitted_by,'subscription.payment_verified',p_method||' order '||o.id::text);
  return jsonb_build_object('status','paid','new_expiry',expiry);
end $$;
revoke all on function public.settle_platform_billing_order(uuid,text,text,numeric) from public,anon,authenticated;
grant execute on function public.settle_platform_billing_order(uuid,text,text,numeric) to service_role;
