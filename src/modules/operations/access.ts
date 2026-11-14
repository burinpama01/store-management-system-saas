import type { Role } from "@/modules/tenants/types";

/**
 * role ที่ตั้งค่า/เปิด-ปิดระบบงานหน้าร้าน ดูประวัติ และเปิดรอบใหม่ได้
 * ต้องตรงกับ RPC ops_* ที่ใช้ auth_user_role_in_store(..., 'admin') — แก้ที่เดียวที่นี่
 */
export const OPS_MANAGER_ROLES: readonly Role[] = ["owner", "admin", "super_admin"];

export function isOpsManagerRole(role: string | null | undefined): boolean {
  return OPS_MANAGER_ROLES.includes(role as Role);
}
