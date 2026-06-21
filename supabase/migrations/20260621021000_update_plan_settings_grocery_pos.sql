-- Preserve admin-edited package copy. Only the latest known seed copy or empty
-- rows are updated to expose Grocery POS phase 1-3 package gates.
with updates(tier, old_feature_lines, new_feature_lines) as (
  values
    (
      'starter',
      '["1 สาขา / 3 สมาชิก","Basic POS","Catalog","Receipt"]'::jsonb,
      '["1 สาขา / 3 สมาชิก","Basic POS","Grocery POS + Barcode","Catalog","Receipt"]'::jsonb
    ),
    (
      'standard',
      '["3 สาขา / 10 สมาชิก","ทุกอย่างใน Starter","Buffet","Stock","Advanced printing","Advanced reports"]'::jsonb,
      '["3 สาขา / 10 สมาชิก","ทุกอย่างใน Starter","Coupon + Loyalty","Buffet","Stock","Advanced printing","Advanced reports"]'::jsonb
    ),
    (
      'premium',
      '["5 สาขา / 50 สมาชิก","ทุกอย่างใน Standard","QR Ordering","LINE Notify","GPS attendance","Advanced permissions"]'::jsonb,
      '["5 สาขา / 50 สมาชิก","ทุกอย่างใน Standard","Customer display","Offline POS readiness","QR Ordering","LINE Notify","GPS attendance","Advanced permissions"]'::jsonb
    ),
    (
      'enterprise',
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างใน Premium","Multi-branch reporting","API Integration","Support พิเศษ"]'::jsonb,
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างใน Premium","Multi-branch reporting","API Integration","Support พิเศษ"]'::jsonb
    )
)
update plan_settings as ps
set feature_lines = updates.new_feature_lines
from updates
where ps.tier = updates.tier
  and (ps.feature_lines = updates.old_feature_lines or ps.feature_lines = '[]'::jsonb);
