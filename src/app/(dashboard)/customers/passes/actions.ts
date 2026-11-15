"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canUseMemberPrivileges, MEMBER_PRIVILEGES_LOCK_MESSAGE } from "@/modules/members/access";
import { isOpsManagerRole } from "@/modules/operations/access";
import { savePassPlan } from "@/modules/prepaid-passes/repository";
import { validatePassPlanInput, type PassPlanInput } from "@/modules/prepaid-passes/rules";
import { logSystemEvent } from "@/modules/system/event-log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** สร้าง/แก้แบบแพ็ก — owner/admin, Enterprise; แพ็กที่ขายไปแล้วไม่เปลี่ยนตาม (snapshot) */
export async function savePassPlanAction(
  planId: string | null,
  input: PassPlanInput,
): Promise<{ ok: boolean; error: string | null; planId?: string }> {
  try {
    const { user, ctx, resolved } = await getResolvedCurrentPermissions();
    if (!isOpsManagerRole(resolved.role)) return { ok: false, error: "เฉพาะเจ้าของหรือแอดมินที่ตั้งค่าแพ็กได้" };
    const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
    if (!canUseMemberPrivileges(billing)) return { ok: false, error: MEMBER_PRIVILEGES_LOCK_MESSAGE };
    if (planId !== null && !UUID_RE.test(planId)) return { ok: false, error: "ข้อมูลแพ็กไม่ถูกต้อง" };
    if (input.productIds.some((id) => !UUID_RE.test(id))) return { ok: false, error: "เมนูที่เลือกไม่ถูกต้อง" };
    const invalid = validatePassPlanInput(input);
    if (invalid) return { ok: false, error: invalid };

    const result = await savePassPlan(ctx.storeId, planId, input);
    await logSystemEvent({
      level: result.error ? "error" : "info",
      source: "prepaid-pass.plan",
      action: "savePassPlan",
      message: result.error ? `บันทึกแบบแพ็กไม่สำเร็จ: ${result.error}` : planId ? "แก้แบบแพ็ก" : "สร้างแบบแพ็ก",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      context: {
        planId: result.data ?? planId,
        credits: input.credits,
        price: input.price,
        validDays: input.validDays,
        redeemScope: input.redeemScope,
        products: input.productIds.length,
        isActive: input.isActive,
      },
    });
    if (result.error !== null) return { ok: false, error: result.error };
    revalidatePath("/customers/passes");
    revalidatePath("/pos");
    return { ok: true, error: null, planId: result.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" };
  }
}
