-- แก้: ร้าน Enterprise (ไม่ใช่ limited / ไม่ใช่ promo trial) สร้าง/ปรับ Stock Pool ไม่ได้
-- ("stock pool creation requires stock.manage and stockManagement access")
--
-- ฝั่งแอป getPlanFeatures (src/modules/billing/types.ts) ถือว่า enterprise หมดอายุได้
-- เฉพาะเมื่อ enterprise_limited = true หรือมี promo_trial_code (isExpiringState) เท่านั้น
-- แต่ฟังก์ชันเดิมบังคับ current_period_end > now() กับ enterprise ทุกแบบ → DB เข้มกว่าแอป
-- ร้านเห็นปุ่มแต่กดแล้วล้ม ปรับให้ตรงกับแอป (แอปคือแหล่งความจริงเรื่องสิทธิ์แพ็กเกจ)
--
-- ผลกระทบ: ใช้ร่วมกับ RPC/RLS ของ Stock Pool (20260905000002/03), คลังวัตถุดิบ A0
-- (20261202120000) และบิลซื้อ A1 (20261206120000) — ทุกจุดได้กติกาใหม่พร้อมกัน
-- ตรวจ prod ก่อนแก้: org ที่ผ่าน 3 → 4, ไม่มี org ใดเสียสิทธิ์
-- Rollback: รัน create or replace ด้วยเนื้อฟังก์ชันเดิมใน 20260905000002
create or replace function public.organization_has_stock_management(p_organization_id uuid)
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
      and s.status in ('active', 'trialing', 'past_due')
      and (
        (s.plan in ('standard', 'premium') and s.current_period_end > now())
        or (
          s.plan = 'enterprise'
          and (
            -- enterprise แบบไม่หมดอายุ (ตรงกับ isExpiringState = false)
            -- nullif(btrim) ให้ตรงกับ Boolean(promo_trial_code) ฝั่งแอป (สตริงว่าง = ไม่ใช่ promo)
            (coalesce(s.enterprise_limited, false) = false and nullif(btrim(s.promo_trial_code), '') is null)
            or s.current_period_end > now()
          )
        )
        or (
          s.plan = 'business'
          and s.current_period_end > now()
          and s.business_seats between 1 and 500
          and s.business_stores between 1 and 50
          and jsonb_typeof(s.business_features) = 'array'
          and s.business_features @> '["stockManagement"]'::jsonb
        )
      )
  );
$$;

revoke all on function public.organization_has_stock_management(uuid) from public;
revoke execute on function public.organization_has_stock_management(uuid) from anon;
grant execute on function public.organization_has_stock_management(uuid) to authenticated;
grant execute on function public.organization_has_stock_management(uuid) to service_role;
