-- แผน "ลงโฆษณาบนจอร้านผ่าน QR" v1 · เฟส A2–A4 (ต่อจาก 20261216120000_store_ad_self_serve_a1)
-- A2 หน้าสาธารณะ /ads/<slug>: คำสั่ง + ลิงก์สถานะ (public_token) + จ่าย Beam (gateway_payments.ad_order_id + trigger) / สลิป
-- A3 แจ้งเตือนหัวข้อใหม่ ad_order (ตั้งช่องทาง/ปิดเปิดได้ในหน้าตั้งค่าแจ้งเตือน)
-- A4 เก็บกวาด: ไม่จ่ายใน 30 นาที → cancelled · ครบกำหนด → expired · ลบไฟล์ผ่าน API (pg_cron + pg_net)
-- additive — ตาราง A1 ยังไม่มีข้อมูลจริง

-- ── A2: คอลัมน์คำสั่งลงโฆษณา ────────────────────────────────────────────────
alter table public.store_ad_orders
  -- กุญแจลิงก์สถานะของผู้ลงโฆษณา (สุ่ม 32 ไบต์) — คนที่มีลิงก์เท่านั้นที่เห็นคำสั่ง
  add column if not exists public_token text,
  -- กดซ้ำ/เน็ตหลุดแล้วส่งใหม่ = คำสั่งเดิม
  add column if not exists client_request_id text,
  add column if not exists gateway_payment_id uuid references public.gateway_payments(id) on delete set null,
  -- หมดเวลาจ่าย (สร้าง + 30 นาที)
  add column if not exists expires_at timestamptz,
  add column if not exists media_size_bytes bigint check (media_size_bytes is null or media_size_bytes > 0),
  -- แจ้งร้านแล้ว (กันซ้ำ: webhook กับหน้าสถานะมาพร้อมกันได้)
  add column if not exists notified_at timestamptz,
  -- ลบไฟล์สื่อออกจาก storage แล้ว (A4)
  add column if not exists media_deleted_at timestamptz;

create unique index if not exists store_ad_orders_public_token_unique
  on public.store_ad_orders (public_token)
  where public_token is not null;

create unique index if not exists store_ad_orders_client_request_unique
  on public.store_ad_orders (store_id, client_request_id)
  where client_request_id is not null;

-- หลักฐานการจ่ายใช้ได้ครั้งเดียว (สลิปเดิมใช้ซ้ำไม่ได้ ทุกร้าน)
create unique index if not exists store_ad_orders_payment_ref_unique
  on public.store_ad_orders (payment_ref)
  where payment_ref is not null;

create index if not exists store_ad_orders_cleanup_idx
  on public.store_ad_orders (status, updated_at)
  where media_path is not null and media_deleted_at is null;

-- ── A2: ผูกรายการชำระ Beam กับคำสั่งลงโฆษณา (1:1) ──────────────────────────
alter table public.gateway_payments
  add column if not exists ad_order_id uuid references public.store_ad_orders(id) on delete set null;

create unique index if not exists gateway_payments_ad_order_unique
  on public.gateway_payments (ad_order_id)
  where ad_order_id is not null;

-- จุดเดียวที่เปลี่ยนคำสั่งเป็น "จ่ายแล้ว" ทั้ง Beam (trigger) และสลิป (RPC จาก server)
-- คืนค่า: active | pending_review | already_paid | late | amount_mismatch | not_found | duplicate_ref
--   ขึ้นจอทันทีเมื่อ ร้านตั้ง auto_publish และช่องยังไม่เต็ม (ล็อกแถวเงื่อนไขร้าน = จ่ายพร้อมกันไม่เกินโควตา)
--   ช่องเต็มตอนจ่าย / ไม่มีสื่อ → pending_review ให้ร้านตัดสิน
create or replace function public.apply_store_ad_order_payment(
  p_order_id uuid,
  p_amount numeric,
  p_method text,
  p_ref text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_ad_orders%rowtype;
  v_offer public.store_ad_offers%rowtype;
  v_active integer;
  v_status text;
  v_reason text;
begin
  if p_method not in ('beam', 'slip') or coalesce(p_ref, '') = '' then
    raise exception 'invalid payment method/ref';
  end if;

  select * into v_order from public.store_ad_orders where id = p_order_id for update;
  if not found then
    return 'not_found';
  end if;
  if v_order.paid_at is not null then
    return 'already_paid';
  end if;
  if v_order.status <> 'pending_payment' then
    return 'late';
  end if;
  if round(v_order.amount, 2) is distinct from round(p_amount, 2) then
    return 'amount_mismatch';
  end if;

  select * into v_offer from public.store_ad_offers where store_id = v_order.store_id for update;
  -- นับเหมือนฝั่งเว็บ (countStoreAdSlotsInUse): กำลังแสดง (ยังไม่หมดอายุ) + จ่ายแล้วรออนุมัติ
  select count(*) into v_active
  from public.store_ad_orders
  where store_id = v_order.store_id
    and id <> v_order.id
    and (
      (status = 'active' and ends_at > now())
      or status = 'pending_review'
    );

  if v_order.media_url is null then
    v_status := 'pending_review';
    v_reason := 'จ่ายแล้วแต่ไม่พบไฟล์สื่อ — ติดต่อผู้ลงโฆษณา';
  elsif coalesce(v_offer.auto_publish, false) and v_active < coalesce(v_offer.max_concurrent, 0) then
    v_status := 'active';
  else
    v_status := 'pending_review';
    if coalesce(v_offer.auto_publish, false) then
      v_reason := 'ช่องโฆษณาเต็มตอนจ่าย — รอร้านอนุมัติ';
    end if;
  end if;

  begin
    update public.store_ad_orders
    set status = v_status,
        paid_at = now(),
        payment_method = p_method,
        payment_ref = p_ref,
        starts_at = case when v_status = 'active' then now() else null end,
        ends_at = case when v_status = 'active' then now() + make_interval(days => v_order.days) else null end,
        status_reason = v_reason,
        updated_at = now()
    where id = v_order.id;
  exception when unique_violation then
    return 'duplicate_ref';
  end;

  return v_status;
end;
$$;

revoke all on function public.apply_store_ad_order_payment(uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.apply_store_ad_order_payment(uuid, numeric, text, text) to service_role;

-- trigger (BEFORE UPDATE → PAID) — จุดเดียวไม่ว่า PAID มาจาก webhook หรือถาม Beam ผ่าน API
--   คำสั่งยกเลิก/หมดเวลาไปแล้ว → LATE_PAID (ร้านคืนเงินเอง) · ยอดไม่ตรง/ไม่พบ → REVIEW_REQUIRED
drop trigger if exists promote_ad_order_on_gateway_paid on public.gateway_payments;

create or replace function public.promote_ad_order_on_gateway_paid()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_store uuid;
  v_result text;
begin
  select store_id into v_store from public.store_ad_orders where id = new.ad_order_id;
  if v_store is null or v_store <> new.store_id then
    new.status := 'REVIEW_REQUIRED';
    new.failure_message := 'ไม่พบคำสั่งลงโฆษณาของรายการชำระนี้ — ตรวจสอบแล้วคืนเงิน';
    return new;
  end if;

  v_result := public.apply_store_ad_order_payment(new.ad_order_id, new.amount, 'beam', 'BEAM:' || new.id::text);

  if v_result = 'late' then
    new.status := 'LATE_PAID';
    new.failure_message := 'เงินเข้าหลังคำสั่งลงโฆษณาหมดเวลา/ถูกยกเลิก — ตรวจแล้วคืนเงินผู้ลงโฆษณา';
  elsif v_result in ('amount_mismatch', 'not_found', 'duplicate_ref') then
    new.status := 'REVIEW_REQUIRED';
    new.failure_message := 'ยอด/รายการไม่ตรงกับคำสั่งลงโฆษณา — ตรวจสอบก่อนขึ้นจอ';
  end if;
  return new;
end;
$$;

revoke all on function public.promote_ad_order_on_gateway_paid() from public;
revoke execute on function public.promote_ad_order_on_gateway_paid() from anon, authenticated;

create trigger promote_ad_order_on_gateway_paid
  before update of status on public.gateway_payments
  for each row
  when (new.ad_order_id is not null and new.status = 'PAID' and old.status is distinct from 'PAID')
  execute function public.promote_ad_order_on_gateway_paid();

-- ── A3: หัวข้อแจ้งเตือน ad_order ("มีคนลงโฆษณา") ────────────────────────────
alter table public.notification_settings
  drop constraint if exists notification_settings_notification_type_check;

alter table public.notification_settings
  add constraint notification_settings_notification_type_check check (
    notification_type in (
      'payment', 'new_table', 'new_pos_order', 'new_qr_order', 'new_buffet_order',
      'new_delivery_order', 'kitchen_order', 'buffet_expiring', 'stock_alert',
      'order_cancelled', 'approval', 'service_request', 'attendance_clock_in',
      'attendance_clock_out', 'test', 'activation_nudge', 'subscription_expiring',
      'daily_summary', 'ops_checklist', 'new_online_order', 'salary_advance_request',
      'pass_purchase', 'ad_order'
    )
  );

alter table public.notification_templates
  drop constraint if exists notification_templates_notification_type_check;

alter table public.notification_templates
  add constraint notification_templates_notification_type_check check (
    notification_type in (
      'payment', 'new_table', 'new_pos_order', 'new_qr_order', 'new_buffet_order',
      'new_delivery_order', 'kitchen_order', 'buffet_expiring', 'stock_alert',
      'order_cancelled', 'approval', 'service_request', 'attendance_clock_in',
      'attendance_clock_out', 'test', 'activation_nudge', 'subscription_expiring',
      'daily_summary', 'ops_checklist', 'new_online_order', 'salary_advance_request',
      'pass_purchase', 'ad_order'
    )
  );

-- ── A4: หมดเวลาจ่าย / ครบกำหนด (SQL ล้วน ทุก 10 นาที) ────────────────────────
create or replace function public.expire_store_ad_orders()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cancelled integer;
  v_expired integer;
begin
  update public.store_ad_orders
  set status = 'cancelled',
      status_reason = coalesce(status_reason, 'ไม่ชำระภายในเวลา'),
      updated_at = now()
  where status = 'pending_payment'
    and expires_at is not null
    and expires_at < now();
  get diagnostics v_cancelled = row_count;

  update public.store_ad_orders
  set status = 'expired',
      updated_at = now()
  where status = 'active'
    and ends_at <= now();
  get diagnostics v_expired = row_count;

  return v_cancelled + v_expired;
end;
$$;

revoke all on function public.expire_store_ad_orders() from public, anon, authenticated;
grant execute on function public.expire_store_ad_orders() to service_role;

-- ไฟล์ที่ควรลบ: ไม่จ่าย (หลังยกเลิก 30 นาที) · หมดอายุ/ถอด/ไม่อนุมัติ เกิน 7 วัน
create or replace function public.store_ad_media_cleanup_due(p_limit integer default 50)
returns table (id uuid, media_path text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, o.media_path
  from public.store_ad_orders o
  where o.media_path is not null
    and o.media_deleted_at is null
    and (
      (o.status = 'cancelled' and o.updated_at < now() - interval '30 minutes')
      or (o.status in ('expired', 'removed', 'rejected') and o.updated_at < now() - interval '7 days')
    )
  order by o.updated_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function public.store_ad_media_cleanup_due(integer) from public, anon, authenticated;
grant execute on function public.store_ad_media_cleanup_due(integer) to service_role;

-- กุญแจ cron (Vault) — แบบเดียวกับ SMS ภารกิจ / สรุปเวลาปิดร้าน
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'ad_cleanup_cron_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'ad_cleanup_cron_key',
      'pg_cron -> /api/ads/cron/cleanup'
    );
  end if;
end $$;

create or replace function public.verify_ad_cleanup_cron_key(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets
    where name = 'ad_cleanup_cron_key' and decrypted_secret = p_key
  ), false);
$$;

revoke all on function public.verify_ad_cleanup_cron_key(text) from public, anon, authenticated;
grant execute on function public.verify_ad_cleanup_cron_key(text) to service_role;

create extension if not exists pg_net with schema extensions;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'store-ad-expire') then
    perform cron.unschedule('store-ad-expire');
  end if;
  if exists (select 1 from cron.job where jobname = 'store-ad-media-cleanup') then
    perform cron.unschedule('store-ad-media-cleanup');
  end if;
end $$;

select cron.schedule('store-ad-expire', '*/10 * * * *', $job$ select public.expire_store_ad_orders(); $job$);

-- ลบไฟล์: ทุกชั่วโมง ยิง API เฉพาะเมื่อมีไฟล์รอลบ (ไม่เปลือง invocation ของ Vercel)
-- URL ผูกโดเมน production แบบเดียวกับ cron อื่น — เปลี่ยนโดเมนต้อง reschedule job นี้ด้วย
select cron.schedule(
  'store-ad-media-cleanup',
  '17 * * * *',
  $job$
  select net.http_post(
    url := 'https://www.store-os.online/api/ads/cron/cleanup',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-ad-cleanup-key',
      (select decrypted_secret from vault.decrypted_secrets where name = 'ad_cleanup_cron_key' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (select 1 from public.store_ad_media_cleanup_due(1));
  $job$
);
