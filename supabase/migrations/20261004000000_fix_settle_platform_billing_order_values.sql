-- แก้ settle_platform_billing_order: INSERT subscriptions มี 13 คอลัมน์แต่ใส่ค่าแค่ 12
-- (trial_end และ promo_trial_code ต้องเป็น null ทั้งคู่ แต่ใส่ null ไว้ตัวเดียว)
--
-- ผลกระทบตั้งแต่ 20260922120000 ขึ้น prod: Beam ยืนยันเงินเข้าแล้ว แต่ RPC ล้มด้วย
-- 42601 "INSERT has more target columns than expressions" ทุกครั้ง ทุกแพ็กเกจ
-- = ร้านจ่ายเงินแล้วไม่ได้ต่ออายุ (พบ 2026-10-04 ตอนทดสอบต่ออายุ Enterprise ด้วยเงินจริง ฿10)
--
-- รายการที่ค้าง pending จะถูกตัดสิทธิ์เองเมื่อ refresh/webhook ครั้งถัดไปเรียก RPC นี้
-- เนื้อหาเหมือน 20260922120000 ทุกบรรทัด ยกเว้น values ของ subscriptions
create or replace function public.settle_platform_billing_order(p_order_id uuid, p_method text, p_ref text, p_amount numeric)
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
  expiry := case
    when o.term_ends_at is not null then o.term_ends_at
    when o.term_days is not null then greatest(coalesce(expiry,now()),now()) + make_interval(days => o.term_days)
    when o.duration = '1y' then greatest(coalesce(expiry,now()),now()) + interval '365 days'
    else greatest(coalesce(expiry,now()),now()) + interval '30 days'
  end;
  insert into public.subscriptions(organization_id,plan,status,current_period_start,current_period_end,cancel_at_period_end,
    trial_end,promo_trial_code,enterprise_limited,business_seats,business_stores,business_features,updated_at)
  values (o.organization_id,o.plan,'active',now(),expiry,false,null,null,o.plan='enterprise',o.business_seats,o.business_stores,o.business_features,now())
  on conflict(organization_id) do update set plan=excluded.plan,status='active',current_period_start=excluded.current_period_start,
    current_period_end=excluded.current_period_end,cancel_at_period_end=false,trial_end=null,promo_trial_code=null,
    enterprise_limited=excluded.enterprise_limited,
    business_seats=excluded.business_seats,business_stores=excluded.business_stores,business_features=excluded.business_features,updated_at=now();
  -- ข้อเสนอแบบ "ถึงวันที่" ใช้ได้ครั้งเดียว — จ่ายซ้ำแล้วได้วันเดิมคือเก็บเงินฟรี
  update public.organization_enterprise_offers
     set active = false, updated_at = now()
   where organization_id = o.organization_id and o.plan = 'enterprise' and term_kind = 'until';
  update public.platform_billing_orders set status='paid',paid_at=now(),new_expiry=expiry where id=o.id;
  insert into public.audit_logs(organization_id,actor_user_id,action,reason)
  values(o.organization_id,o.submitted_by,'subscription.payment_verified',p_method||' order '||o.id::text);
  return jsonb_build_object('status','paid','new_expiry',expiry);
end $$;
revoke all on function public.settle_platform_billing_order(uuid,text,text,numeric) from public,anon,authenticated;
grant execute on function public.settle_platform_billing_order(uuid,text,text,numeric) to service_role;
