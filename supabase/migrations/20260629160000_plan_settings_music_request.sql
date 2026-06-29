-- Expose the new Enterprise "music request + auto player" feature on the
-- landing/pricing page. Preserve admin-edited copy: only the latest known seed
-- copy or empty rows are updated.
with updates(tier, old_feature_lines, new_feature_lines) as (
  values
    (
      'enterprise',
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างใน Premium","Member QR + Loyalty + Coupons + Customer display","Multi-branch reporting","API Integration","Support พิเศษ"]'::jsonb,
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างใน Premium","Member QR + Loyalty + Coupons + Customer display","ขอเพลง + เครื่องเล่นเพลงอัตโนมัติ","Multi-branch reporting","API Integration","Support พิเศษ"]'::jsonb
    )
)
update plan_settings as ps
set feature_lines = updates.new_feature_lines
from updates
where ps.tier = updates.tier
  and (ps.feature_lines = updates.old_feature_lines or ps.feature_lines = '[]'::jsonb);
