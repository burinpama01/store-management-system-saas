import type { FeatureKey } from "./types";

/**
 * Canonical Thai feature copy shown on the public /pricing page. This is the
 * source of truth that the seed migration applies and the sync guard test
 * checks against PLAN_FEATURES, so the landing page can never advertise a
 * feature a tier does not actually unlock. Edit here + the seed migration
 * together (the test enforces they match).
 */
export const LANDING_FEATURE_LINES: Record<string, string[]> = {
  starter: [
    "1 สาขา / 3 สมาชิก",
    "POS พื้นฐาน",
    "POS ร้านชำ + บาร์โค้ด",
    "จัดการเมนูสินค้า",
    "พิมพ์ใบเสร็จ",
  ],
  standard: [
    "3 สาขา / 10 สมาชิก",
    "ทุกอย่างในแพ็กเกจ Starter",
    "ระบบบุฟเฟต์",
    "จัดการสต็อก",
    "พิมพ์ใบเสร็จขั้นสูง",
    "รายงานขั้นสูง",
  ],
  premium: [
    "5 สาขา / 50 สมาชิก",
    "ทุกอย่างในแพ็กเกจ Standard",
    "สั่งอาหารผ่าน QR",
    "คูปอง + สะสมแต้ม",
    "แจ้งเตือนผ่าน LINE",
    "ลงเวลาด้วย GPS",
    "รองรับ POS ออฟไลน์",
    "กำหนดสิทธิ์ขั้นสูง",
  ],
  enterprise: [
    "ไม่จำกัดสาขา/สมาชิก",
    "ทุกอย่างในแพ็กเกจ Premium",
    "จอแสดงผลลูกค้า",
    "สมาชิก QR + สะสมแต้ม + คูปอง",
    "ขอเพลง + เครื่องเล่นเพลงอัตโนมัติ",
    "รายงานหลายสาขา",
    "เชื่อมต่อ API",
    "ซัพพอร์ตพิเศษ",
  ],
};

/**
 * Maps a copy keyword to the feature it advertises. If a tier's feature lines
 * contain the keyword, that tier MUST unlock the feature in PLAN_FEATURES.
 * Use phrases specific enough not to false-match (e.g. "สั่งอาหารผ่าน QR",
 * not bare "QR").
 */
export const FEATURE_LINE_KEYWORDS: ReadonlyArray<{ keyword: string; feature: FeatureKey }> = [
  { keyword: "คูปอง", feature: "couponManagement" },
  { keyword: "สะสมแต้ม", feature: "loyaltyPoints" },
  { keyword: "จอแสดงผลลูกค้า", feature: "customerDisplay" },
  { keyword: "สั่งอาหารผ่าน QR", feature: "qrOrdering" },
  { keyword: "ระบบบุฟเฟต์", feature: "buffetManagement" },
  { keyword: "จัดการสต็อก", feature: "stockManagement" },
  { keyword: "พิมพ์ใบเสร็จขั้นสูง", feature: "advancedPrinting" },
  { keyword: "รายงานขั้นสูง", feature: "advancedReports" },
  { keyword: "รองรับ POS ออฟไลน์", feature: "offlinePos" },
  { keyword: "แจ้งเตือนผ่าน LINE", feature: "lineNotify" },
  { keyword: "ลงเวลาด้วย GPS", feature: "attendanceGps" },
  { keyword: "กำหนดสิทธิ์ขั้นสูง", feature: "advancedPermissions" },
  { keyword: "รายงานหลายสาขา", feature: "multiBranchReporting" },
  { keyword: "เชื่อมต่อ API", feature: "apiIntegration" },
  { keyword: "ขอเพลง", feature: "musicRequest" },
];
