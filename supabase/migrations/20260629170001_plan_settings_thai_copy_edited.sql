-- Translate the admin-edited Standard/Premium package copy to Thai.
-- (These rows were customized via /system/pricing so the seed-based translation
--  in 20260629170000 preserved them; this targets the live edited values.)
with updates(tier, old_feature_lines, new_feature_lines) as (
  values
    (
      'standard',
      '["3 สาขา / 10 สมาชิก","ทุกอย่างใน Starter","Buffet","Stock","Advanced printing","Advanced reports"]'::jsonb,
      '["3 สาขา / 10 สมาชิก","ทุกอย่างในแพ็กเกจ Starter","ระบบบุฟเฟต์","จัดการสต็อก","พิมพ์ใบเสร็จขั้นสูง","รายงานขั้นสูง"]'::jsonb
    ),
    (
      'premium',
      '["ทุกอย่างใน Standard","QR Food Ordering","Notify","ลงชื่อเข้าออกงานของพนักงาน"]'::jsonb,
      '["ทุกอย่างในแพ็กเกจ Standard","สั่งอาหารผ่าน QR","การแจ้งเตือน","ลงชื่อเข้าออกงานของพนักงาน"]'::jsonb
    )
)
update plan_settings as ps
set feature_lines = updates.new_feature_lines
from updates
where ps.tier = updates.tier
  and ps.feature_lines = updates.old_feature_lines;
