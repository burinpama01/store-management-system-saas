-- ============================================================
-- เฟส C0 — สินค้าซื้อขาด/ฝากขาย: ฐาน (Plan/Resale and Consignment Goods Implementation Plan v2.html)
--
--   * สวิตช์ต่อสาขา stores.consignment_enabled — ปิดทุกร้านเป็นค่าเริ่มต้น
--   * เจ้าของขนม = ผู้ขาย (suppliers จากเฟส A0) + วิธีรับเงิน + รอบเคลียร์เงิน
--   * สิทธิ์: แพ็กเกจ Enterprise เท่านั้น (ให้ตรงกับ PlanFeatures.consignment ในแอป)
--   * ยังไม่แตะเส้นทางขาย/ปิดรอบ (C2/C3)
-- ============================================================

alter table public.stores
  add column if not exists consignment_enabled boolean not null default false;
comment on column public.stores.consignment_enabled is
  'เปิดระบบสินค้าซื้อขาด/ฝากขาย (เฟส C) — ปิดทุกร้านเป็นค่าเริ่มต้น';

alter table public.suppliers
  add column if not exists payout_method text not null default 'cash'
    check (payout_method in ('cash', 'transfer')),
  add column if not exists payout_account text
    check (payout_account is null or char_length(payout_account) <= 120),
  add column if not exists settle_cycle text not null default 'restock'
    check (settle_cycle in ('daily', 'restock'));
comment on column public.suppliers.payout_method is 'ฝากขาย: เจ้าของรับเงินสดหรือโอน';
comment on column public.suppliers.payout_account is 'ฝากขาย: พร้อมเพย์/เลขบัญชี (ข้อความแสดงผล ไม่ใช้โอนอัตโนมัติ)';
comment on column public.suppliers.settle_cycle is 'ฝากขาย: เคลียร์เงินทุกวันตอนปิดรอบ (daily) หรือตอนเติมของ (restock)';

-- สิทธิ์ Enterprise ฝั่ง DB — ให้ตรงกับ getPlanFeatures (src/modules/billing/types.ts):
--   สถานะที่ใช้ได้ = active/trialing/past_due
--   enterprise หมดอายุได้เฉพาะแถวที่ทำเครื่องหมาย enterprise_limited หรือมาจากโปรทดลอง (promo_trial_code)
create or replace function public.organization_has_consignment(p_organization_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.organization_id = p_organization_id
      and s.plan = 'enterprise'
      and s.status in ('active', 'trialing', 'past_due')
      and (
        (coalesce(s.enterprise_limited, false) = false and s.promo_trial_code is null)
        or s.current_period_end > now()
      )
  );
$$;

revoke all on function public.organization_has_consignment(uuid) from public;
revoke execute on function public.organization_has_consignment(uuid) from anon;
grant execute on function public.organization_has_consignment(uuid) to authenticated;
grant execute on function public.organization_has_consignment(uuid) to service_role;

create or replace function public.consignment_set_enabled(p_store_id uuid, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select organization_id into v_org from public.stores where id = p_store_id;
  if v_org is null then
    raise exception 'store not found';
  end if;
  if not public.auth_user_role_in_store(v_org, p_store_id, 'admin') then
    raise exception 'only owner/admin can toggle consignment';
  end if;
  if coalesce(p_enabled, false) and not public.organization_has_consignment(v_org) then
    raise exception 'consignment requires enterprise plan';
  end if;
  update public.stores set consignment_enabled = coalesce(p_enabled, false) where id = p_store_id;
  return coalesce(p_enabled, false);
end;
$$;

revoke all on function public.consignment_set_enabled(uuid, boolean) from public, anon;
grant execute on function public.consignment_set_enabled(uuid, boolean) to authenticated;
grant execute on function public.consignment_set_enabled(uuid, boolean) to service_role;
