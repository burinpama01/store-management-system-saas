/**
 * ใครใช้คลังวัตถุดิบได้ (pure — เทสต์ได้)
 * - ต้องผ่านด่านระบบต้นทุนก่อน (manager ขึ้นไป + รายงานขั้นสูง + ร้านอาหาร) เพราะคลังคือส่วนต่อของวัตถุดิบ/ต้นทุน
 * - แพ็กเกจต้องมี stockManagement (แผนเฟส A ข้อ 6 อนุมัติ 2026-11-21)
 * - เปิด/ปิดคลังของสาขา: owner/admin เท่านั้น
 * - สาขายังไม่เปิดคลัง: เห็นหน้าได้ (เพื่อเปิดสวิตช์) แต่ตั้งยอดไม่ได้
 */
import type { CostingAccessDecision } from "@/modules/costing/access-policy";

export const INVENTORY_TOGGLE_ROLES = ["super_admin", "owner", "admin"] as const;

export type InventoryAccessDecision =
  | { allowed: true; canEdit: boolean; canManageSuppliers: boolean; canToggle: boolean; enabled: boolean }
  | { allowed: false; message: string };

export function decideInventoryAccess(input: {
  costing: CostingAccessDecision;
  hasStockManagement: boolean;
  stockPlanLockMessage?: string | null;
  role: string;
  enabled: boolean;
}): InventoryAccessDecision {
  if (!input.costing.allowed) return { allowed: false, message: input.costing.message };
  if (!input.hasStockManagement) {
    return { allowed: false, message: input.stockPlanLockMessage ?? "คลังวัตถุดิบอยู่ในแพ็กเกจที่มีระบบสต็อก" };
  }
  const canToggle = (INVENTORY_TOGGLE_ROLES as readonly string[]).includes(input.role);
  return {
    allowed: true,
    canEdit: input.costing.canEdit && input.enabled,
    // ทะเบียนผู้ขายใช้ได้แม้ยังไม่เปิดคลัง (เตรียมข้อมูลก่อนเปิด)
    canManageSuppliers: input.costing.canEdit,
    canToggle,
    enabled: input.enabled,
  };
}
