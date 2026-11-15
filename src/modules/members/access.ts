import { canUseFeature, type BillingState } from "@/modules/billing/types";

/**
 * รหัสยืนยันสมาชิก (และแพ็กล่วงหน้า/ระดับสมาชิกที่จะตามมา) เป็นฟีเจอร์ Enterprise เท่านั้น
 * — ผู้ใช้ตัดสินใจ 2026-11-15; ใช้ plan === "enterprise" ตรง ๆ แทนการเพิ่มคีย์ใน PlanFeatures
 * เพื่อไม่ให้ไปโผล่เป็นตัวเลือกขายในแผน business
 * canUseFeature จะคืน false เองเมื่อแพ็กเกจหมดอายุ/ถูกระงับ
 */
export function canUseMemberPrivileges(state: BillingState): boolean {
  return state.plan === "enterprise" && canUseFeature(state, "loyaltyPoints");
}

export const MEMBER_PRIVILEGES_LOCK_MESSAGE = "รหัสยืนยันสมาชิกใช้ได้เฉพาะแพ็กเกจ Enterprise";
