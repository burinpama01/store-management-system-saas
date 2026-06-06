"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { setTenantSuspension, setTenantPlan } from "@/modules/system/repository";
import type { BillingPlan } from "@/modules/billing/types";

const VALID_PLANS: BillingPlan[] = ["free", "starter", "standard", "premium", "enterprise"];

export interface SuspensionState {
  error: string | null;
}

export async function setTenantSuspensionAction(
  _prev: SuspensionState,
  formData: FormData,
): Promise<SuspensionState> {
  let user;
  try {
    user = await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return { error: "ต้องเป็นผู้ดูแลแพลตฟอร์ม" };
    throw e;
  }

  const organizationId = (formData.get("organizationId") as string | null) ?? "";
  const suspend = formData.get("suspend") === "1";
  const reason = ((formData.get("reason") as string | null) ?? "").trim();
  if (!organizationId) return { error: "ไม่พบ organization" };

  const res = await setTenantSuspension({
    organizationId,
    suspend,
    actorUserId: user.id,
    reason,
  });
  if (!res.ok) return { error: res.error ?? "ดำเนินการไม่สำเร็จ" };

  revalidatePath(`/system/tenants/${organizationId}`);
  revalidatePath("/system/tenants");
  return { error: null };
}

export async function setTenantPlanAction(
  _prev: SuspensionState,
  formData: FormData,
): Promise<SuspensionState> {
  let user;
  try {
    user = await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return { error: "ต้องเป็นผู้ดูแลแพลตฟอร์ม" };
    throw e;
  }

  const organizationId = (formData.get("organizationId") as string | null) ?? "";
  const plan = (formData.get("plan") as string | null) ?? "";
  if (!organizationId) return { error: "ไม่พบ organization" };
  if (!VALID_PLANS.includes(plan as BillingPlan)) return { error: "แพ็กเกจไม่ถูกต้อง" };

  const res = await setTenantPlan({
    organizationId,
    plan: plan as BillingPlan,
    actorUserId: user.id,
  });
  if (!res.ok) return { error: res.error ?? "เปลี่ยนแพ็กเกจไม่สำเร็จ" };

  revalidatePath(`/system/tenants/${organizationId}`);
  revalidatePath("/system/tenants");
  return { error: null };
}
