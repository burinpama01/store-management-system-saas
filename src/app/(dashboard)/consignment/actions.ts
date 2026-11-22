"use server";

import { revalidatePath } from "next/cache";
import { getConsignmentAccess } from "@/modules/consignment/access";
import { setConsignmentEnabled } from "@/modules/consignment/repository";
import { saveSupplier } from "@/modules/inventory/repository";
import type { SupplierInput } from "@/modules/inventory/types";
import { validateSupplier } from "@/modules/inventory/validate";
import { logSystemEvent } from "@/modules/system/event-log";

type ActionResult = { error: string | null };

/** ทุกเส้นทางฝากขายต้องทิ้ง log ทั้งสำเร็จและล้มเหลว (กฎโปรเจกต์: ห้ามสำเร็จแบบเงียบ) */
async function logConsignment(input: {
  action: string;
  ok: boolean;
  message: string;
  organizationId: string;
  storeId: string;
  actorUserId: string;
  context?: Record<string, unknown>;
}) {
  await logSystemEvent({
    level: input.ok ? "info" : "warn",
    source: "consignment",
    action: input.action,
    message: input.message,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: input.context,
  }).catch(() => undefined);
}

function revalidateConsignment() {
  revalidatePath("/consignment");
  revalidatePath("/costing/suppliers");
}

export async function setConsignmentEnabledAction(enabled: boolean): Promise<ActionResult> {
  const { user, ctx, decision } = await getConsignmentAccess();
  if (!decision.allowed) return { error: decision.message };
  if (!decision.canToggle) return { error: "เปิด/ปิดได้เฉพาะเจ้าของหรือแอดมิน" };
  const result = await setConsignmentEnabled(ctx.storeId, enabled === true);
  await logConsignment({
    action: "setConsignmentEnabled",
    ok: !result.error,
    message: result.error
      ? `เปลี่ยนสวิตช์ฝากขายไม่สำเร็จ: ${result.error}`
      : enabled
        ? "เปิดระบบสินค้าซื้อขาด/ฝากขาย"
        : "ปิดระบบสินค้าซื้อขาด/ฝากขาย",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { enabled },
  });
  if (result.error) return { error: result.error };
  // เมนู "ฝากขาย" ขึ้นกับแพ็ก+role ไม่ใช่สวิตช์ → ไม่ต้อง revalidate layout ทั้งหน้า
  revalidateConsignment();
  return { error: null };
}

/** บันทึกเจ้าของสินค้า/ผู้ขาย พร้อมช่องฝากขาย (วิธีรับเงิน + รอบเคลียร์) */
export async function saveConsignmentSupplierAction(input: SupplierInput): Promise<ActionResult> {
  const { user, ctx, decision } = await getConsignmentAccess();
  if (!decision.allowed) return { error: decision.message };
  if (!decision.canManageSuppliers) return { error: "ไม่มีสิทธิ์แก้ทะเบียนผู้ขาย" };
  if (!input.consignment) return { error: "กรุณาเลือกวิธีรับเงินและรอบเคลียร์เงิน" };
  const validated = validateSupplier(input);
  if ("error" in validated) return { error: validated.error };

  const result = await saveSupplier({ organizationId: ctx.organizationId, storeId: ctx.storeId }, validated.value);
  await logConsignment({
    action: "saveSupplier",
    ok: !result.error,
    message: result.error ? `บันทึกเจ้าของสินค้าไม่สำเร็จ: ${result.error}` : input.id ? "แก้เจ้าของสินค้า" : "เพิ่มเจ้าของสินค้า",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: {
      supplierId: result.data?.id ?? input.id ?? null,
      payoutMethod: validated.value.consignment?.payoutMethod,
      settleCycle: validated.value.consignment?.settleCycle,
      isActive: validated.value.isActive,
    },
  });
  if (result.error) return { error: result.error };
  revalidateConsignment();
  return { error: null };
}
