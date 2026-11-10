/**
 * ใครเห็น/แก้ระบบต้นทุนได้ (pure — เทสต์ได้)
 * - แพ็กเกจมี advancedReports (v2 ข้อ 1)
 * - ร้านอาหาร: businessMode = restaurant · ร้านเก่าที่ยังไม่มีโปรไฟล์ถือว่าใช้ได้
 *   (ร้านนำร่องส่วนใหญ่ตั้งก่อนมีโปรไฟล์) ซ่อนเฉพาะร้านที่ระบุชัดว่าเป็น retail/service
 * - ดู: reports.view + role manager ขึ้นไป (RLS ตารางต้นทุนเป็น manager — ต่ำกว่านี้จะเห็นข้อมูลว่าง)
 * - แก้: เพิ่ม catalog.manage
 */
export const COSTING_MANAGER_ROLES = ["super_admin", "owner", "admin", "manager"] as const;

export type CostingAccessDecision =
  | { allowed: true; canEdit: boolean }
  | { allowed: false; reason: "no_permission" | "role" | "plan" | "business_mode"; message: string };

export function decideCostingAccess(input: {
  canViewReports: boolean;
  canManageCatalog: boolean;
  role: string;
  hasAdvancedReports: boolean;
  planLockMessage?: string | null;
  businessMode: "retail" | "restaurant" | "service" | null;
}): CostingAccessDecision {
  if (!input.canViewReports) return { allowed: false, reason: "no_permission", message: "ไม่มีสิทธิ์ดูรายงาน" };
  if (!(COSTING_MANAGER_ROLES as readonly string[]).includes(input.role)) {
    return { allowed: false, reason: "role", message: "ข้อมูลต้นทุนและกำไรดูได้เฉพาะผู้จัดการขึ้นไป" };
  }
  if (!input.hasAdvancedReports) {
    return { allowed: false, reason: "plan", message: input.planLockMessage ?? "ระบบต้นทุนอยู่ในแพ็กเกจที่มีรายงานขั้นสูง (Standard ขึ้นไป)" };
  }
  if (input.businessMode !== null && input.businessMode !== "restaurant") {
    return { allowed: false, reason: "business_mode", message: "ระบบต้นทุนตามสูตรเมนูรองรับร้านอาหารก่อน" };
  }
  return { allowed: true, canEdit: input.canManageCatalog };
}
