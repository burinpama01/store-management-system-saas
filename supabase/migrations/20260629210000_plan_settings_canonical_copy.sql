-- Standardise the public /pricing feature copy so it matches PLAN_FEATURES exactly
-- (#package-feature-sync). Premium now advertises คูปอง/สะสมแต้ม (moved down from
-- Enterprise) plus its real offline/advanced-permissions perks; Enterprise drops
-- the coupon/loyalty exclusivity line and keeps customer-display/API/multi-branch.
-- The copy here is the source of truth mirrored in
-- src/modules/billing/landing-feature-lines.ts and guarded by
-- tests/unit/plan-copy-feature-sync.test.ts.

update plan_settings set feature_lines =
  '["1 สาขา / 3 สมาชิก","POS พื้นฐาน","POS ร้านชำ + บาร์โค้ด","จัดการเมนูสินค้า","พิมพ์ใบเสร็จ"]'::jsonb,
  updated_at = now()
 where tier = 'starter';

update plan_settings set feature_lines =
  '["3 สาขา / 10 สมาชิก","ทุกอย่างในแพ็กเกจ Starter","ระบบบุฟเฟต์","จัดการสต็อก","พิมพ์ใบเสร็จขั้นสูง","รายงานขั้นสูง"]'::jsonb,
  updated_at = now()
 where tier = 'standard';

update plan_settings set feature_lines =
  '["5 สาขา / 50 สมาชิก","ทุกอย่างในแพ็กเกจ Standard","สั่งอาหารผ่าน QR","คูปอง + สะสมแต้ม","แจ้งเตือนผ่าน LINE","ลงเวลาด้วย GPS","รองรับ POS ออฟไลน์","กำหนดสิทธิ์ขั้นสูง"]'::jsonb,
  updated_at = now()
 where tier = 'premium';

update plan_settings set feature_lines =
  '["ไม่จำกัดสาขา/สมาชิก","ทุกอย่างในแพ็กเกจ Premium","จอแสดงผลลูกค้า","สมาชิก QR + สะสมแต้ม + คูปอง","ขอเพลง + เครื่องเล่นเพลงอัตโนมัติ","รายงานหลายสาขา","เชื่อมต่อ API","ซัพพอร์ตพิเศษ"]'::jsonb,
  updated_at = now()
 where tier = 'enterprise';
