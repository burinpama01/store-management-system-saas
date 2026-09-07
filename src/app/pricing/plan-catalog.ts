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
  { key: "apiIntegration", label: "เชื่อมต่อเดลิเวอรีและ API" },
  { key: "aiVision", label: "AI สแกนเมนูจากรูปภาพ" },
  { key: "aiAssistant", label: "ผู้ช่วย AI ช่วยแก้ปัญหาอุปกรณ์" },
  // ไม่ใส่ aiForecast: มีแค่ราคา component ของ Business ยังไม่มีฟีเจอร์ให้ผู้ใช้จริง
];

// ความสามารถที่ไม่มี feature gate ในโค้ด = ทุกแพ็กเกจใช้ได้ ไม่ต้องซื้อเพิ่ม
// เพิ่มรายการใหม่ที่นี่ได้เฉพาะเมื่อยืนยันแล้วว่าไม่มี requireFeature/canUseFeature คุมอยู่
export const ALWAYS_INCLUDED: { title: string; detail: string }[] = [
  { title: "สั่งงานด้วยเสียงในหน้าขาย", detail: "พูดสั่งเมนู แก้ตัวเลือกในตะกร้า และเปิดหน้าจอในระบบ ร้านเปิดใช้เองได้ในตั้งค่า" },
  { title: "ขายหน้าร้านและออกใบเสร็จ", detail: "รับออเดอร์ ชำระเงิน พิมพ์ใบเสร็จ และพิมพ์ซ้ำจากประวัติบิล" },
  { title: "พิมพ์ผ่านคอมพิวเตอร์ร้าน", detail: "StoreOS Print Hub และ Launcher บน Windows ให้แท็บเล็ตส่งงานเข้าเครื่องพิมพ์ตัวเดียวกัน" },
  { title: "แอปมือถือ Android", detail: "รับแจ้งเตือนออเดอร์และงานในร้านบนมือถือ" },
  { title: "ลงเวลาและคำนวณเงินเดือน", detail: "ตอกบัตร กะ วันหยุด ปฏิทินทีม และสลิปเงินเดือน" },
  { title: "รายรับ-รายจ่ายและรอบเงินสด", detail: "บันทึกรายการ ปิดรอบ และตรวจส่วนต่างในลิ้นชัก" },
];

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
