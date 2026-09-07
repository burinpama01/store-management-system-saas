import { getPlanDefinition, type FeatureKey } from "@/modules/billing/types";
import type { PlanTier } from "@/modules/billing/pricing-repository";

// Only describe implemented customer-facing capabilities; entitlement definitions
// determine availability. Editable marketing copy cannot grant or advertise access.
export const COMPARISON_FEATURES: { key: Exclude<FeatureKey, "maxStores" | "maxMembers">; label: string }[] = [
  { key: "groceryPos", label: "POS ร้านชำและบาร์โค้ด" },
  { key: "buffetManagement", label: "จัดการบุฟเฟต์" },
  { key: "stockManagement", label: "สต็อกสินค้าและ Stock Pool" },
  { key: "advancedPrinting", label: "พิมพ์ใบเสร็จขั้นสูง" },
  { key: "advancedReports", label: "รายงานขั้นสูงและ CSV" },
  { key: "qrOrdering", label: "สั่งอาหารผ่าน QR" },
  { key: "couponManagement", label: "จัดการคูปอง" },
  { key: "loyaltyPoints", label: "สะสมแต้ม" },
  { key: "attendanceGps", label: "ลงเวลาด้วย GPS" },
  { key: "offlinePos", label: "ขายเงินสดออฟไลน์ใน POS ร้านชำ" },
  { key: "lineNotify", label: "แจ้งเตือนผ่าน LINE" },
  { key: "advancedPermissions", label: "กำหนดสิทธิ์ขั้นสูง" },
  { key: "customerDisplay", label: "จอแสดงผลลูกค้า" },
  { key: "multiBranchReporting", label: "เพิ่มสาขาและรายงานหลายสาขา" },
  { key: "musicRequest", label: "ขอเพลงและเครื่องเล่นเพลง" },
];

export function planLimit(tier: PlanTier, key: "maxStores" | "maxMembers"): string {
  if (tier === "business") return "เลือกจำนวนเอง";
  const value = getPlanDefinition(tier)[key];
  return Number.isFinite(value) ? value.toLocaleString("th-TH") : "ไม่จำกัด";
}

export function featureAvailability(tier: PlanTier, key: FeatureKey): string {
  if (tier === "business") return "เลือกเพิ่ม";
  return getPlanDefinition(tier)[key] ? "รวมแล้ว" : "ไม่รวม";
}

export function planHighlights(tier: PlanTier): string[] {
  if (tier === "business") return ["เริ่มต้น 1 สาขา · 1 สมาชิก · ยังไม่รวมฟีเจอร์เสริม", "เลือกจำนวนสมาชิกและสาขา", "เลือกซื้อฟีเจอร์ที่ต้องใช้", "คำนวณราคาก่อนชำระในหน้าตั้งค่าแพ็กเกจ"];
  const features = getPlanDefinition(tier);
  const previous = tier === "standard" ? "starter" : tier === "premium" ? "standard" : tier === "enterprise" ? "premium" : null;
  const base = previous ? [`รวมฟีเจอร์ของ ${previous[0].toUpperCase() + previous.slice(1)}`] : ["POS พื้นฐานและจัดการเมนู", "พิมพ์ใบเสร็จ"];
  return [...base, ...COMPARISON_FEATURES.filter(({ key }) => features[key] && (!previous || !getPlanDefinition(previous)[key])).map(({ label }) => label)];
}
