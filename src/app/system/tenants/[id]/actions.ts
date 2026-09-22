"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { setTenantSuspension, setTenantPlan } from "@/modules/system/repository";
import type { BillingPlan } from "@/modules/billing/types";
import { describeOfferRejection, parseEnterpriseOfferInput } from "@/modules/billing/enterprise-offer";
import { upsertEnterpriseOffer } from "@/modules/billing/enterprise-offer-repository";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

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

  // Enterprise: แอดมินเลือกได้ว่าเป็นสัญญาไม่มีวันหมดอายุ หรือจำกัดเวลาถึงวันที่กำหนด
  const enterpriseLimited = formData.get("enterpriseLimited") === "1";
  const endsRaw = ((formData.get("enterpriseEndsAt") as string | null) ?? "").trim();
  let enterpriseEndsAt: string | null = null;
  if (plan === "enterprise" && enterpriseLimited) {
    if (!endsRaw) return { error: "กรุณาระบุวันหมดอายุของสัญญาแบบจำกัดเวลา" };
    const parsed = new Date(endsRaw);
    if (Number.isNaN(parsed.getTime())) return { error: "วันหมดอายุไม่ถูกต้อง" };
    if (parsed.getTime() <= Date.now()) return { error: "วันหมดอายุต้องเป็นวันในอนาคต" };
    enterpriseEndsAt = parsed.toISOString();
  }

  const res = await setTenantPlan({
    organizationId,
    plan: plan as BillingPlan,
    actorUserId: user.id,
    enterpriseLimited,
    enterpriseEndsAt,
  });
  if (!res.ok) return { error: res.error ?? "เปลี่ยนแพ็กเกจไม่สำเร็จ" };

  revalidatePath(`/system/tenants/${organizationId}`);
  revalidatePath("/system/tenants");
  return { error: null };
}

/**
 * ตั้งราคาและอายุต่ออายุ Enterprise เฉพาะบัญชีนี้ — ซุปเปอร์แอดมินเท่านั้น
 * ยอดที่เรียกเก็บจริงอ่านจากตารางนี้ฝั่งเซิร์ฟเวอร์เสมอ ไม่เคยรับยอดจาก client
 */
export async function saveEnterpriseOfferAction(
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
  if (!organizationId) return { error: "ไม่พบ organization" };

  const parsed = parseEnterpriseOfferInput({
    amount: formData.get("amount"),
    termKind: formData.get("termKind"),
    termDays: formData.get("termDays"),
    endsAt: formData.get("endsAt"),
    note: formData.get("note"),
  });
  if (!parsed.ok) return { error: describeOfferRejection(parsed.reason) };

  const active = formData.get("active") === "1";
  const res = await upsertEnterpriseOffer({
    organizationId,
    amount: parsed.amount,
    term: parsed.term,
    note: parsed.note,
    active,
    updatedBy: user.id,
  });
  if (!res.ok) return { error: res.error ?? "บันทึกข้อเสนอไม่สำเร็จ" };

  const supabase = await createSupabaseServiceClient();
  await supabase.from("audit_logs").insert({
    organization_id: organizationId,
    store_id: null,
    actor_user_id: user.id,
    target_user_id: null,
    action: "subscription.enterprise_offer.set",
    reason: `${parsed.amount} บาท · ${
      parsed.term.kind === "days" ? `${parsed.term.days} วัน` : `ถึง ${parsed.term.endsAt}`
    } · ${active ? "เปิด" : "ปิด"}`,
  });

  revalidatePath(`/system/tenants/${organizationId}`);
  return { error: null };
}
