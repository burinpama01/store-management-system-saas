-- Preserve plan copy edited from /system/pricing. Only rows that still match the
-- original seed copy, or an empty default row, are updated to the new matrix.
with updates(tier, old_feature_lines, new_feature_lines) as (
  values
    (
      'starter',
      '["POS พื้นฐาน","รายรับ-รายจ่าย","พิมพ์ใบเสร็จผ่าน Browser","ประวัติลูกค้า"]'::jsonb,
      '["1 สาขา / 3 สมาชิก","Basic POS","Catalog","Receipt"]'::jsonb
    ),
    (
      'standard',
      '["ทุกอย่างใน Starter","จัดการบุฟเฟต์","จัดการสต็อก","พิมพ์ Bluetooth/USB/IP"]'::jsonb,
      '["3 สาขา / 10 สมาชิก","ทุกอย่างใน Starter","Buffet","Stock","Advanced printing","Advanced reports"]'::jsonb
    ),
    (
      'premium',
      '["ทุกอย่างใน Standard","QR Food Ordering","LINE Notify","ลงเวลา GPS + คอมมิชชั่น"]'::jsonb,
      '["5 สาขา / 50 สมาชิก","ทุกอย่างใน Standard","QR Ordering","LINE Notify","GPS attendance","Advanced permissions"]'::jsonb
    ),
    (
      'enterprise',
      '["จัดการสาขาแบบศูนย์กลาง","รายงานรวมหลายสาขา","API Integration","Support พิเศษ"]'::jsonb,
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างใน Premium","Multi-branch reporting","API Integration","Support พิเศษ"]'::jsonb
    )
)
update plan_settings as ps
set feature_lines = updates.new_feature_lines
from updates
where ps.tier = updates.tier
  and (ps.feature_lines = updates.old_feature_lines or ps.feature_lines = '[]'::jsonb);
