"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges, MEMBER_PRIVILEGES_LOCK_MESSAGE } from "@/modules/members/access";
import { setMemberCodeEnabled } from "@/modules/members/repository";
import { isOpsManagerRole } from "@/modules/operations/access";
import { logSystemEvent } from "@/modules/system/event-log";

/** เปิด/ปิดรหัสยืนยันสมาชิก 5 นาทีของสาขาปัจจุบัน — owner/admin เท่านั้น */
export async function setMemberCodeEnabledAction(enabled: boolean): Promise<{ ok: boolean; error: string | null }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!isOpsManagerRole(resolved.role)) return { ok: false, error: "ไม่มีสิทธิ์ทำรายการนี้" };
    const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
    if (enabled && !canUseMemberPrivileges(billing)) return { ok: false, error: MEMBER_PRIVILEGES_LOCK_MESSAGE };

    const result = await setMemberCodeEnabled(ctx.storeId, enabled);
    await logSystemEvent({
      level: result.error ? "error" : "info",
      source: "member.code",
      action: "setMemberCodeEnabled",
      message: result.error
        ? `เปลี่ยนสวิตช์รหัสสมาชิกไม่สำเร็จ: ${result.error}`
        : enabled
          ? "เปิดรหัสยืนยันสมาชิก"
          : "ปิดรหัสยืนยันสมาชิก",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: { enabled },
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/settings/member-privileges");
    revalidatePath("/pos");
    revalidatePath("/member", "layout");
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" };
  }
}
