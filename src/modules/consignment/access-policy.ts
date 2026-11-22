/**
 * ใครใช้ระบบสินค้าซื้อขาด/ฝากขายได้ (pure — เทสต์ได้)
 * Plan/Resale and Consignment Goods Implementation Plan v2.html เฟส C0
 * - แพ็กเกจ Enterprise เท่านั้น (PlanFeatures.consignment)
 * - manager ขึ้นไป (ไม่ผูกโหมดร้านอาหาร — ร้านค้าปลีกรับของฝากขายได้เหมือนกัน)
 * - เปิด/ปิดสาขา: owner/admin เท่านั้น
 * - สาขายังไม่เปิด: เห็นหน้าได้ (เพื่อเปิดสวิตช์ + เตรียมผู้ขาย) แต่ยังรับของ/ขายไม่ได้
 */
export const CONSIGNMENT_MANAGER_ROLES = ["super_admin", "owner", "admin", "manager"] as const;
export const CONSIGNMENT_TOGGLE_ROLES = ["super_admin", "owner", "admin"] as const;

export const CONSIGNMENT_PLAN_LOCK_MESSAGE = "สินค้าซื้อขาด/ฝากขาย ใช้ได้เฉพาะแพ็กเกจ Enterprise";
export const CONSIGNMENT_ROLE_LOCK_MESSAGE = "หน้านี้สำหรับผู้จัดการขึ้นไป";

export type ConsignmentAccessDecision =
  | { allowed: true; canManageSuppliers: boolean; canToggle: boolean; enabled: boolean; canOperate: boolean }
  | { allowed: false; message: string };

export function decideConsignmentAccess(input: {
  hasConsignment: boolean;
  role: string;
  enabled: boolean;
}): ConsignmentAccessDecision {
  if (!input.hasConsignment) return { allowed: false, message: CONSIGNMENT_PLAN_LOCK_MESSAGE };
  if (!(CONSIGNMENT_MANAGER_ROLES as readonly string[]).includes(input.role)) {
    return { allowed: false, message: CONSIGNMENT_ROLE_LOCK_MESSAGE };
  }
  return {
    allowed: true,
    // ทะเบียนเจ้าของ/ผู้ขายเตรียมได้ก่อนเปิดสวิตช์
    canManageSuppliers: true,
    canToggle: (CONSIGNMENT_TOGGLE_ROLES as readonly string[]).includes(input.role),
    enabled: input.enabled,
    canOperate: input.enabled,
  };
}

/** เมนูนำทาง: แสดงเมื่อมีสิทธิ์ (แม้ยังไม่เปิด เพื่อให้เจ้าของเข้าไปเปิดได้) */
export function isConsignmentNavVisible(input: { hasConsignment: boolean; role: string }): boolean {
  return decideConsignmentAccess({ ...input, enabled: false }).allowed;
}
