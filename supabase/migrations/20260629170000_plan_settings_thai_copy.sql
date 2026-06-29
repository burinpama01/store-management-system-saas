-- Translate package feature copy to Thai (keep technical terms POS/QR/LINE/GPS/API).
-- Conditional update preserves admin-edited copy (only known seed values updated).
with updates(tier, old_feature_lines, new_feature_lines) as (
  values
    (
      'starter',
      '["1 สาขา / 3 สมาชิก","Basic POS","Grocery POS + Barcode","Catalog","Receipt"]'::jsonb,
      '["1 สาขา / 3 สมาชิก","POS พื้นฐาน","POS ร้านชำ + บาร์โค้ด","จัดการเมนูสินค้า","พิมพ์ใบเสร็จ"]'::jsonb
    ),
    (
      'standard',
      '["3 สาขา / 10 สมาชิก","ทุกอย่างใน Starter","Coupon + Loyalty","Buffet","Stock","Advanced printing","Advanced reports"]'::jsonb,
      '["3 สาขา / 10 สมาชิก","ทุกอย่างในแพ็กเกจ Starter","คูปอง + สะสมแต้ม","ระบบบุฟเฟต์","จัดการสต็อก","พิมพ์ใบเสร็จขั้นสูง","รายงานขั้นสูง"]'::jsonb
    ),
    (
      'premium',
      '["5 สาขา / 50 สมาชิก","ทุกอย่างใน Standard","Customer display","Offline POS readiness","QR Ordering","LINE Notify","GPS attendance","Advanced permissions"]'::jsonb,
      '["5 สาขา / 50 สมาชิก","ทุกอย่างในแพ็กเกจ Standard","จอแสดงผลลูกค้า","รองรับ POS ออฟไลน์","สั่งอาหารผ่าน QR","แจ้งเตือนผ่าน LINE","ลงเวลาด้วย GPS","กำหนดสิทธิ์ขั้นสูง"]'::jsonb
    ),
    (
      'enterprise',
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างใน Premium","Member QR + Loyalty + Coupons + Customer display","ขอเพลง + เครื่องเล่นเพลงอัตโนมัติ","Multi-branch reporting","API Integration","Support พิเศษ"]'::jsonb,
      '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างในแพ็กเกจ Premium","สมาชิก QR + สะสมแต้ม + คูปอง + จอลูกค้า","ขอเพลง + เครื่องเล่นเพลงอัตโนมัติ","รายงานหลายสาขา","เชื่อมต่อ API","ซัพพอร์ตพิเศษ"]'::jsonb
    )
)
update plan_settings as ps
set feature_lines = updates.new_feature_lines
from updates
where ps.tier = updates.tier
  and (ps.feature_lines = updates.old_feature_lines or ps.feature_lines = '[]'::jsonb);
