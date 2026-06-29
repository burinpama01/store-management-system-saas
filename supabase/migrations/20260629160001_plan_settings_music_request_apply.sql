-- Apply the Enterprise "music request + auto player" landing copy.
-- (20260629160000 ran before the Member-package line was accounted for and
--  no-op'd against the live data; this re-applies against the current copy.)
-- Idempotent: no-ops once the line is already present.
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
  and ps.feature_lines = updates.old_feature_lines;
