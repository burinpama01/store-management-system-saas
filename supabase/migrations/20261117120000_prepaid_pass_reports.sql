-- แพ็กซื้อล่วงหน้า · P3 — รายงานแพ็ก + ลงบัญชีรายรับเมื่อขายออนไลน์
--
-- 1) prepaid_pass_report(): สรุปช่วงวันที่ (เวลาไทย) ต่อสาขา
--    - ขายแพ็ก: จำนวน/มูลค่า แยก POS กับออนไลน์ (สาขาที่ขาย)
--    - ใช้สิทธิ์: จำนวนสิทธิ์สุทธิ (ใช้ − คืน) + "รายได้ที่รับรู้" = มูลค่าต่อสิทธิ์ × สิทธิ์ที่ใช้ (สาขาที่ใช้)
--    - สิทธิ์ถูกยกเลิก: แพ็กหมดอายุ + ยกเลิกบิลขายแพ็ก
--    - ยอดคงค้าง ณ ตอนนี้ (หนี้สินจากเงินรับล่วงหน้า): สิทธิ์ที่เหลือ × มูลค่าต่อสิทธิ์ ของแพ็กที่สาขานี้ขาย
-- 2) ขายออนไลน์ผ่าน Beam → บันทึก transactions รายรับ หมวด "ขายแพ็กออนไลน์" (POS บันทึกผ่านการปิดบิลอยู่แล้ว)

-- ---------------------------------------------------------------------------
-- รายงาน
-- ---------------------------------------------------------------------------
create or replace function public.prepaid_pass_report(p_store_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
begin
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null then raise exception 'ไม่พบสาขา'; end if;
  if auth.uid() is null or not auth_user_has_permission(v_org, p_store_id, 'reports.view') then
    raise exception 'ไม่มีสิทธิ์ดูรายงาน';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'ช่วงวันที่ไม่ถูกต้อง (สูงสุด 400 วัน)';
  end if;

  v_start := (p_from::timestamp) at time zone 'Asia/Bangkok';
  v_end := ((p_to + 1)::timestamp) at time zone 'Asia/Bangkok';

  -- หมายเหตุ: event type 'adjust' ยังไม่มีฟังก์ชันสร้าง — ถ้าเพิ่มในอนาคตต้องเพิ่มสูตรในรายงานนี้ด้วย
  with ev as (
    select e.*, ps.accepted_channel, ps.plan_name, ps.plan_id
      from public.prepaid_pass_events e
      join public.prepaid_passes ps on ps.id = e.pass_id
     where e.store_id = p_store_id
       and e.created_at >= v_start and e.created_at < v_end
  ),
  sold as (
    select count(*) filter (where type = 'issue') as count_all,
           coalesce(sum(value_delta) filter (where type = 'issue'), 0) as value_all,
           count(*) filter (where type = 'issue' and accepted_channel = 'pos') as count_pos,
           coalesce(sum(value_delta) filter (where type = 'issue' and accepted_channel = 'pos'), 0) as value_pos,
           count(*) filter (where type = 'issue' and accepted_channel = 'online') as count_online,
           coalesce(sum(value_delta) filter (where type = 'issue' and accepted_channel = 'online'), 0) as value_online,
           coalesce(-sum(credits_delta) filter (where type in ('redeem', 'release', 'reverse')), 0) as credits_used,
           coalesce(sum(value_delta) filter (where type in ('redeem', 'release', 'reverse')), 0) as value_recognized,
           coalesce(-sum(credits_delta) filter (where type = 'expire'), 0) as credits_expired,
           coalesce(-sum(value_delta) filter (where type = 'expire'), 0) as value_expired,
           count(*) filter (where type = 'void') as count_voided,
           coalesce(-sum(value_delta) filter (where type = 'void'), 0) as value_voided
      from ev
  ),
  by_plan as (
    -- แยกตามแบบแพ็ก (plan_id) — แบบเก่ากับแบบใหม่ชื่อซ้ำกันไม่ถูกรวมเป็นแถวเดียว
    select plan_id, plan_name,
           count(*) filter (where type = 'issue') as sold,
           coalesce(sum(value_delta) filter (where type = 'issue'), 0) as sold_value,
           coalesce(-sum(credits_delta) filter (where type in ('redeem', 'release', 'reverse')), 0) as credits_used,
           coalesce(sum(value_delta) filter (where type in ('redeem', 'release', 'reverse')), 0) as value_recognized
      from ev
     group by plan_id, plan_name
  ),
  outstanding as (
    select count(*) as passes,
           coalesce(sum(credits_remaining), 0) as credits,
           coalesce(sum(round(credits_remaining * unit_value, 2)), 0) as value,
           count(*) filter (where expires_at is not null and expires_at < now() + interval '7 days') as expiring_7d
      from public.prepaid_passes
     where issued_store_id = p_store_id
       and status = 'active'
       and credits_remaining > 0
       and (expires_at is null or expires_at > now())
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'sold', (select to_jsonb(sold) from sold),
    'outstanding', (select to_jsonb(outstanding) from outstanding),
    'by_plan', coalesce((select jsonb_agg(to_jsonb(by_plan) order by sold_value desc, plan_name) from by_plan), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.prepaid_pass_report(uuid, date, date) from public, anon;
grant execute on function public.prepaid_pass_report(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- ขายออนไลน์ → รายรับในบัญชี (แทนที่ฟังก์ชันจาก 20261116130000 — logic ออกแพ็กเหมือนเดิมทุกบรรทัด)
-- ---------------------------------------------------------------------------
create or replace function public.issue_prepaid_pass_on_gateway_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pur public.prepaid_pass_purchases%rowtype;
  v_pass_id uuid;
  v_category public.accounting_categories%rowtype;
  v_recorder uuid;
begin
  select * into v_pur
    from public.prepaid_pass_purchases
   where id = new.prepaid_pass_purchase_id and store_id = new.store_id
   for update;

  if not found then
    new.status := 'REVIEW_REQUIRED';
    new.failure_message := 'ไม่พบคำสั่งซื้อแพ็กของรายการชำระนี้ — ตรวจสอบแล้วคืนเงิน';
    return new;
  end if;

  if v_pur.status = 'paid' then
    return new;
  end if;

  if round(v_pur.amount, 2) is distinct from round(new.amount, 2) then
    new.status := 'REVIEW_REQUIRED';
    new.failure_message := 'ยอดที่จ่ายไม่ตรงกับราคาแพ็ก — ตรวจสอบก่อนออกแพ็ก';
    return new;
  end if;

  insert into public.prepaid_passes (
    organization_id, plan_id, member_identity_id, issued_store_id, customer_id, purchase_id,
    plan_name, credits_total, credits_remaining, unit_value, price_paid, redeem_scope,
    expires_at, terms_snapshot, accepted_at, accepted_channel, accepted_by
  ) values (
    v_pur.organization_id, v_pur.plan_id, v_pur.member_identity_id, v_pur.store_id, v_pur.customer_id, v_pur.id,
    v_pur.plan_name, v_pur.credits, v_pur.credits, round(v_pur.amount / v_pur.credits, 4), v_pur.amount, v_pur.redeem_scope,
    case when v_pur.valid_days is null then null else now() + make_interval(days => v_pur.valid_days) end,
    v_pur.terms_snapshot, v_pur.accepted_at, 'online', null
  )
  on conflict (purchase_id) do nothing
  returning id into v_pass_id;

  if v_pass_id is not null then
    insert into public.prepaid_pass_events (organization_id, pass_id, store_id, type, credits_delta, value_delta, note)
    values (v_pur.organization_id, v_pass_id, v_pur.store_id, 'issue', v_pur.credits, v_pur.amount, 'ซื้อออนไลน์ผ่าน Beam ' || new.id::text);

    -- รายรับในบัญชี: ผู้บันทึก = คนที่สร้างแบบแพ็ก หรือเจ้าของร้าน (transactions.created_by_user_id บังคับ)
    select coalesce(
      (select created_by from public.prepaid_pass_plans where id = v_pur.plan_id),
      (select m.user_id from public.memberships m
        where m.organization_id = v_pur.organization_id and m.role = 'owner'
        order by m.created_at limit 1)
    ) into v_recorder;

    if v_recorder is not null then
      perform pg_advisory_xact_lock(hashtextextended(v_pur.store_id::text, 2));
      select * into v_category
        from public.accounting_categories
       where store_id = v_pur.store_id and type = 'income' and name = 'ขายแพ็กออนไลน์'
       order by sort_order, name
       limit 1;
      if not found then
        insert into public.accounting_categories (organization_id, store_id, name, type, is_default, sort_order)
        values (v_pur.organization_id, v_pur.store_id, 'ขายแพ็กออนไลน์', 'income', false, 1)
        returning * into v_category;
      end if;
      insert into public.transactions (
        organization_id, store_id, type, category_id, category_name, amount, note, date, created_by_user_id
      ) values (
        v_pur.organization_id, v_pur.store_id, 'income', v_category.id, v_category.name, v_pur.amount,
        'ขาย' || v_pur.plan_name || ' ออนไลน์ (Beam ' || new.id::text || ')',
        (now() at time zone 'Asia/Bangkok')::date, v_recorder
      );
      insert into public.system_event_logs (level, source, action, message, organization_id, store_id, context, fingerprint)
      values ('info', 'prepaid-pass.online', 'issueOnlinePass', 'ออกแพ็กออนไลน์และลงบัญชีรายรับแล้ว',
              v_pur.organization_id, v_pur.store_id,
              jsonb_build_object('purchaseId', v_pur.id, 'passId', v_pass_id, 'gatewayPaymentId', new.id, 'amount', v_pur.amount),
              md5('prepaid-pass.online|issueOnlinePass|ok'));
    else
      -- ไม่มีผู้บันทึก (แบบแพ็กไม่มี created_by และองค์กรไม่มี owner) → ออกแพ็กแล้วแต่ลงบัญชีไม่ได้: บันทึกให้ตามแก้
      insert into public.system_event_logs (level, source, action, message, organization_id, store_id, context, fingerprint)
      values ('error', 'prepaid-pass.online', 'issueOnlinePass', 'ออกแพ็กออนไลน์แล้วแต่ลงบัญชีรายรับไม่ได้ (ไม่พบผู้บันทึก)',
              v_pur.organization_id, v_pur.store_id,
              jsonb_build_object('purchaseId', v_pur.id, 'passId', v_pass_id, 'gatewayPaymentId', new.id, 'amount', v_pur.amount),
              md5('prepaid-pass.online|issueOnlinePass|no_recorder'));
    end if;
  else
    select id into v_pass_id from public.prepaid_passes where purchase_id = v_pur.id;
  end if;

  update public.prepaid_pass_purchases
     set status = 'paid', pass_id = v_pass_id, updated_at = now()
   where id = v_pur.id;

  if new.status = 'LATE_PAID' then
    new.status := 'PAID';
    new.failure_message := null;
  end if;

  return new;
end;
$$;

revoke all on function public.issue_prepaid_pass_on_gateway_paid() from public, anon, authenticated;
