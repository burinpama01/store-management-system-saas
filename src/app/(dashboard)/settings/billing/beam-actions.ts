"use server";
import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { isPaidTier } from "@/modules/billing/pricing";
import { parseBusinessConfigJson } from "@/modules/billing/business-plan";
import { createPlatformBillingOrder, getPendingPlatformBillingOrder, refreshPlatformBillingOrder } from "@/modules/billing/beam-billing";

async function context() {
  const ctx = await getResolvedCurrentPermissions();
  if (!ctx.resolved.can("billing.manage")) throw new Error("ไม่มีสิทธิ์จัดการการชำระเงิน");
  return ctx;
}

export async function createBeamPackageAction(input: { plan: string; duration: string; businessConfigJson?: string; discountCode?: string }) {
  const { ctx, user } = await context();
  const isEnterprise = input.plan === "enterprise";
  // enterprise ใช้อายุจากข้อเสนอรายบัญชี (createPlatformBillingOrder ตรวจข้อเสนอซ้ำเอง)
  const duration = isEnterprise ? "30d" : input.duration;
  if ((!isPaidTier(input.plan) && input.plan !== "business" && !isEnterprise) || (duration !== "30d" && duration !== "1y")) throw new Error("ข้อมูลแพ็กเกจไม่ถูกต้อง");
  const businessConfig = input.plan === "business" ? parseBusinessConfigJson(input.businessConfigJson) : null;
  if (input.plan === "business" && !businessConfig) throw new Error("ข้อมูล Business ไม่ครบ");
  return createPlatformBillingOrder({ ...input, plan: input.plan as "starter" | "standard" | "premium" | "business" | "enterprise", duration, businessConfig,
    organizationId: ctx.organizationId, submittedByUserId: user.id });
}

export async function refreshBeamPackageAction(id: string) {
  const { ctx } = await context();
  const order = await refreshPlatformBillingOrder(id, ctx.organizationId);
  if (order.status === "paid") revalidatePath("/settings/billing");
  return order;
}

export async function pendingBeamPackageAction() {
  const { ctx } = await context();
  return getPendingPlatformBillingOrder(ctx.organizationId);
}
