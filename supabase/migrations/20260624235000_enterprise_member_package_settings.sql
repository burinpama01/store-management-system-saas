-- Preserve admin-edited package copy. Only rows that still match the latest
-- known seed copy, or empty rows, are updated to move member commerce into Enterprise.
with updates(tier, old_feature_lines, new_feature_lines) as (
  values
    (
      'standard',
      '["3 สาขา / 10 สมาชิก","ทุกอย่างใน Starter","Coupon + Loyalty","Buffet","Stock","Advanced printing","Advanced reports"]'::jsonb,
      '["3 สาขา / 10 สมาชิก","ทุกอย่างใน Starter","Buffet","Stock","Advanced printing","Advanced reports"]'::jsonb
    ),
    (
      'premium',
      '["5 สาขา / 50 สมาชิก","ทุกอย่างใน Standard","Customer display","Offline POS readiness","QR Ordering","LINE Notify","GPS attendance","Advanced permissions"]'::jsonb,
      '["5 สาขา / 50 สมาชิก","ทุกอย่างใน Standard","Offline POS readiness","QR Ordering","LINE Notify","GPS attendance","Advanced permissions"]'::jsonb
    ),
    (
      'enterprise',
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างใน Premium","Multi-branch reporting","API Integration","Support พิเศษ"]'::jsonb,
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างใน Premium","Member QR + Loyalty + Coupons + Customer display","Multi-branch reporting","API Integration","Support พิเศษ"]'::jsonb
    )
)
update plan_settings as ps
set feature_lines = updates.new_feature_lines,
    updated_at = now()
from updates
where ps.tier = updates.tier
  and (ps.feature_lines = updates.old_feature_lines or ps.feature_lines = '[]'::jsonb);
