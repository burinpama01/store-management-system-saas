/**
 * ระดับที่ร้านอนุญาตให้ Print Hub เลือกเครื่องพิมพ์ USB เอง
 *
 * แยกออกมาเป็นไฟล์ของตัวเองเพราะหน้าตั้งค่า (client component) ต้องใช้ค่าเหล่านี้
 * ส่วน print-hub.ts มี dependency ที่รันได้เฉพาะฝั่งเซิร์ฟเวอร์ (node:net ผ่าน
 * network-printer) — ถ้า client import จากที่นั่นตรง ๆ bundler จะลาก net เข้า
 * bundle ฝั่งเบราว์เซอร์แล้ว build พัง (เจอจริงตอน deploy 2026-09-04)
 */

export type HubUsbBindingPolicy = "auto_single" | "confirm_multi" | "manual";

export const HUB_USB_BINDING_POLICIES: ReadonlyArray<{
  readonly value: HubUsbBindingPolicy;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "auto_single",
    label: "ตรวจจับอัตโนมัติ (แนะนำสำหรับร้านที่มีเครื่องพิมพ์ตัวเดียว)",
    hint: "เสียบสาย USB แล้วพิมพ์ได้เลย ย้ายพอร์ตหรือเปลี่ยนสายก็ไม่ต้องตั้งค่าใหม่",
  },
  {
    value: "confirm_multi",
    label: "ให้ยืนยันก่อนทุกครั้งที่เปลี่ยนเครื่อง",
    hint: "เหมาะกับร้านที่มีเครื่องพิมพ์หลายตัว — ระบบจะไม่เดาให้ ต้องเลือกเองก่อนพิมพ์",
  },
  {
    value: "manual",
    label: "ใช้เฉพาะเครื่องที่เลือกไว้เท่านั้น",
    hint: "ถ้าเครื่องที่ผูกไว้หายไป จะไม่พิมพ์ออกเครื่องอื่นเด็ดขาด",
  },
];

/** ค่าจากฟอร์ม/ฐานข้อมูลอาจเป็นอะไรก็ได้ — ตกลงมาที่ค่าที่ปลอดภัยที่สุดเสมอ */
export function parseUsbBindingPolicy(value: unknown): HubUsbBindingPolicy {
  return value === "confirm_multi" || value === "manual" ? value : "auto_single";
}
