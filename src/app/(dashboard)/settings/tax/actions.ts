"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { isOpsManagerRole } from "@/modules/operations/access";
import { logSystemEvent } from "@/modules/system/event-log";
import { setTaxDocumentsEnabled } from "@/modules/tax/documents-repository";
import { saveStoreTaxProfile } from "@/modules/tax/repository";
import { validateTaxProfile } from "@/modules/tax/rules";
import type { StoreTaxProfileInput } from "@/modules/tax/types";

type ActionResult = { error: string | null };

/** ข้อมูลภาษีเป็นข้อมูลทางกฎหมาย — owner/admin เท่านั้น (ตรงกับ RLS) และต้องทิ้ง log ทุกครั้ง */
export async function saveTaxProfileAction(input: StoreTaxProfileInput): Promise<ActionResult> {
  const { user, ctx } = await getResolvedCurrentPermissions();
  if (!isOpsManagerRole(ctx.role)) return { error: "แก้ข้อมูลภาษีได้เฉพาะเจ้าของหรือแอดมิน" };
  const validated = validateTaxProfile(input);
  if ("error" in validated) return { error: validated.error };

  const result = await saveStoreTaxProfile({ organizationId: ctx.organizationId, storeId: ctx.storeId }, validated.value, user.id);
  await logSystemEvent({
    level: result.error ? "warn" : "info",
    source: "tax",
    action: "saveTaxProfile",
    message: result.error ? `บันทึกข้อมูลภาษีไม่สำเร็จ: ${result.error}` : "บันทึกข้อมูลภาษีของสาขา",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: {
      vatRegistered: validated.value.vatRegistered,
      hasPosApproval: Boolean(validated.value.posApprovalNo),
      branchCode: validated.value.branchCode,
      pricesIncludeVat: validated.value.pricesIncludeVat,
    },
  }).catch(() => undefined);
  if (result.error) return { error: result.error };
  revalidatePath("/settings/tax");
  return { error: null };
}

/** เปิด/ปิดใบกำกับภาษีเต็มรูปของสาขา — owner/admin (RPC ตรวจแพ็ก + จด VAT ซ้ำ) */
export async function setTaxDocumentsEnabledAction(enabled: boolean): Promise<ActionResult> {
  const { user, ctx } = await getResolvedCurrentPermissions();
  if (!isOpsManagerRole(ctx.role)) return { error: "เปิด/ปิดได้เฉพาะเจ้าของหรือแอดมิน" };
  const result = await setTaxDocumentsEnabled(ctx.storeId, enabled === true);
  await logSystemEvent({
    level: result.error ? "warn" : "info",
    source: "tax",
    action: "setTaxDocumentsEnabled",
    message: result.error ? `เปลี่ยนสวิตช์ใบกำกับภาษีไม่สำเร็จ: ${result.error}` : enabled ? "เปิดใช้ใบกำกับภาษีเต็มรูป" : "ปิดใบกำกับภาษีเต็มรูป",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { enabled },
  }).catch(() => undefined);
  if (result.error) return { error: result.error };
  revalidatePath("/settings/tax");
  revalidatePath("/tax-documents");
  return { error: null };
}
