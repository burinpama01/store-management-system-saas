import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { BillingState } from "@/modules/billing/types";
import { canUseMemberPrivileges } from "@/modules/members/access";

/**
 * O1 (ผู้ใช้ตัดสินใจ 2026-11-15): องค์กรหมด Enterprise → หยุดขายแพ็กใหม่ แต่ลูกค้ายังใช้แพ็กที่จ่ายแล้วได้
 * จนหมดอายุ เพราะลูกค้าจ่ายเงินไปแล้วและขอคืนไม่ได้
 *
 * "grace" = ไม่ใช่ Enterprise ที่ใช้งานอยู่ แต่ยังมีแพ็กที่ใช้ได้ค้างในองค์กร → เปิดเฉพาะ
 * ยืนยันรหัสสมาชิก + ใช้แพ็ก (ไม่ขายแพ็ก ไม่สะสม/แลกแต้ม ไม่ค้น/สมัครสมาชิก)
 */
export async function orgHasActivePasses(organizationId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตารางใหม่ยังไม่อยู่ใน database.types
  const db: any = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("prepaid_passes")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .gt("credits_remaining", 0)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .limit(1);
  if (error) {
    console.error("[prepaid-pass] orgHasActivePasses failed", { organizationId, error: error.message });
    return false;
  }
  return (data ?? []).length > 0;
}

export interface MemberPassAccess {
  /** Enterprise ใช้งานอยู่ — ทำได้ทุกอย่าง */
  privileges: boolean;
  /** หมด Enterprise แต่มีแพ็กค้าง — ยืนยันรหัส + ใช้แพ็กได้อย่างเดียว */
  grace: boolean;
}

export async function resolveMemberPassAccess(organizationId: string, billing: BillingState): Promise<MemberPassAccess> {
  if (canUseMemberPrivileges(billing)) return { privileges: true, grace: false };
  return { privileges: false, grace: await orgHasActivePasses(organizationId) };
}

/** ใช้รหัส/แพ็กได้ไหม (ขายแพ็กใหม่ต้องใช้ privileges เท่านั้น) */
export function canRedeemPasses(access: MemberPassAccess): boolean {
  return access.privileges || access.grace;
}
