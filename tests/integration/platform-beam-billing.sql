-- Run only inside the verification script's transaction (always ROLLBACK).
do $$
declare
  org uuid := gen_random_uuid(); actor uuid := gen_random_uuid();
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  expiry timestamptz; result jsonb; before_count integer;
begin
  if has_table_privilege('authenticated','public.platform_billing_orders','SELECT') then raise exception 'authenticated can read private orders'; end if;
  if has_table_privilege('anon','public.platform_billing_orders','INSERT') then raise exception 'anon can write orders'; end if;
  if has_function_privilege('authenticated','public.settle_platform_billing_order(uuid,text,text,numeric)','EXECUTE') then raise exception 'client can settle'; end if;
  insert into auth.users(id) values(actor);
  insert into public.organizations(id,name,slug,owner_id) values(org,'Beam billing transaction test','beam-billing-'||org,actor);
  insert into public.platform_billing_orders(id,organization_id,submitted_by,plan,duration,amount,method,environment,status,charge_id,expires_at)
  values(a,org,actor,'starter','30d',690,'beam','live','pending','fixture-charge-'||a,now()+interval '15 minutes');
  begin
    perform public.settle_platform_billing_order(a,'beam','fixture-charge-'||a,689);
    raise exception 'wrong amount accepted';
  exception when others then
    if sqlerrm <> 'evidence_mismatch' then raise; end if;
  end;
  result := public.settle_platform_billing_order(a,'beam','fixture-charge-'||a,690);
  if result->>'status' <> 'paid' then raise exception 'not paid'; end if;
  select current_period_end into expiry from public.subscriptions where organization_id=org;
  perform public.settle_platform_billing_order(a,'beam','fixture-charge-'||a,690);
  if expiry <> (select current_period_end from public.subscriptions where organization_id=org) then raise exception 'replay extended twice'; end if;
  if (select count(*) from public.payment_submissions where organization_id=org) <> 1 then raise exception 'duplicate evidence'; end if;
  insert into public.platform_billing_orders(id,organization_id,submitted_by,plan,duration,amount,method,environment,status,charge_id,expires_at)
  values(b,org,actor,'premium','1y',22900,'beam','test','pending','fixture-charge-'||b,now()+interval '15 minutes');
  perform public.settle_platform_billing_order(b,'beam','fixture-charge-'||b,22900);
  if expiry <> (select current_period_end from public.subscriptions where organization_id=org) then raise exception 'test granted real access'; end if;
  if (select plan from public.subscriptions where organization_id=org) <> 'starter' then raise exception 'test changed plan'; end if;
  insert into public.platform_billing_orders(id,organization_id,submitted_by,plan,duration,amount,method,environment,status,expires_at)
  values(c,org,actor,'standard','30d',1290,'slip','live','pending',now()+interval '15 minutes');
  perform public.settle_platform_billing_order(c,'slip','fixture-bank-ref-'||c,1290);
  select current_period_end into expiry from public.subscriptions where organization_id=org;
  select count(*) into before_count from public.payment_submissions where organization_id=org;
  insert into public.platform_billing_orders(id,organization_id,submitted_by,plan,duration,amount,method,environment,status,expires_at)
  values(gen_random_uuid(),org,actor,'standard','30d',1290,'slip','live','pending',now()+interval '15 minutes') returning id into a;
  begin
    perform public.settle_platform_billing_order(a,'slip','fixture-bank-ref-'||c,1290);
    raise exception 'reused slip accepted';
  exception when unique_violation then null;
  end;
  if expiry <> (select current_period_end from public.subscriptions where organization_id=org) or before_count <> (select count(*) from public.payment_submissions where organization_id=org) then raise exception 'duplicate was not atomic'; end if;
  raise notice 'PASS: private permissions, amount mismatch, live entitlement, replay, sandbox isolation, slip replay rollback';
end $$;
