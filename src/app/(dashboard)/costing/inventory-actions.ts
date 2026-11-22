"use server";

import { revalidatePath } from "next/cache";
import { getInventoryAccess } from "@/modules/inventory/access";
import {
  ingredientBelongsToStore,
  saveIngredientInventorySettings,
  saveSupplier,
  setIngredientBalance,
  setInventoryEnabled,
} from "@/modules/inventory/repository";
import type { SupplierInput } from "@/modules/inventory/types";
import { logSystemEvent } from "@/modules/system/event-log";
import { validateSupplier } from "@/modules/inventory/validate";

type ActionResult = { error: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QTY = 9_999_999_999;

/** ทุกเส้นทางคลังต้องทิ้ง log ทั้งสำเร็จและล้มเหลว (กฎโปรเจกต์: ห้ามสำเร็จแบบเงียบ) */
async function logInventory(input: {
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
    source: "inventory",
    action: input.action,
    message: input.message,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: input.context,
  }).catch(() => undefined);
}

function revalidateInventory() {
  revalidatePath("/costing/inventory");
  revalidatePath("/costing/suppliers");
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function cleanText(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export async function setInventoryEnabledAction(enabled: boolean): Promise<ActionResult> {
  const { user, ctx, decision } = await getInventoryAccess();
  if (!decision.allowed) return { error: decision.message };
  if (!decision.canToggle) return { error: "เปิด/ปิดคลังได้เฉพาะเจ้าของหรือแอดมิน" };
  const result = await setInventoryEnabled(ctx.storeId, enabled === true);
  await logInventory({
    action: "setInventoryEnabled",
    ok: !result.error,
    message: result.error ? `เปลี่ยนสวิตช์คลังไม่สำเร็จ: ${result.error}` : enabled ? "เปิดคลังวัตถุดิบ" : "ปิดคลังวัตถุดิบ",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { enabled },
  });
  if (result.error) return { error: result.error };
  revalidateInventory();
  return { error: null };
}

export async function setIngredientBalanceAction(input: {
  ingredientId: string;
  kind: "opening" | "manual_adjust";
  newOnHand: number;
  reason: string | null;
  unitCost: number | null;
}): Promise<ActionResult> {
  const { user, ctx, decision } = await getInventoryAccess();
  if (!decision.allowed) return { error: decision.message };
  if (!decision.enabled) return { error: "สาขานี้ยังไม่ได้เปิดคลังวัตถุดิบ" };
  if (!decision.canEdit) return { error: "ต้องมีสิทธิ์จัดการเมนูจึงจะปรับยอดคลังได้" };
  if (!UUID_RE.test(input.ingredientId)) return { error: "ข้อมูลวัตถุดิบไม่ถูกต้อง" };
  if (input.kind !== "opening" && input.kind !== "manual_adjust") return { error: "ชนิดการปรับยอดไม่ถูกต้อง" };
  if (!finite(input.newOnHand) || input.newOnHand < 0 || input.newOnHand > MAX_QTY) return { error: "ยอดคงเหลือต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป" };
  if (input.unitCost !== null && (!finite(input.unitCost) || input.unitCost < 0 || input.unitCost > 99_999_999)) {
    return { error: "ต้นทุนต่อหน่วยไม่ถูกต้อง" };
  }
  const reason = cleanText(input.reason, 300);
  if (input.kind === "manual_adjust" && !reason) return { error: "กรุณาระบุเหตุผลที่ปรับยอด" };
  // กันปรับยอดวัตถุดิบของสาขาอื่น (ผู้จัดการหลายสาขา) — สวิตช์/ log ใช้สาขาปัจจุบัน ต้องตรงกับวัตถุดิบ
  if (!(await ingredientBelongsToStore(ctx.storeId, input.ingredientId))) return { error: "ไม่พบวัตถุดิบนี้ในสาขา" };

  const result = await setIngredientBalance({ ...input, reason });
  await logInventory({
    action: input.kind === "opening" ? "setOpeningBalance" : "manualAdjust",
    ok: !result.error,
    message: result.error
      ? `ปรับยอดคลังไม่สำเร็จ: ${result.error}`
      : input.kind === "opening"
        ? "ตั้งยอดยกมาวัตถุดิบ"
        : "ปรับยอดคลังวัตถุดิบด้วยมือ",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { ingredientId: input.ingredientId, newOnHand: input.newOnHand, reason, unitCost: input.unitCost },
  });
  if (result.error) return { error: result.error };
  revalidateInventory();
  return { error: null };
}

export async function saveIngredientInventorySettingsAction(input: {
  ingredientId: string;
  reorderPoint: number | null;
  safetyDays: number;
  defaultSupplierId: string | null;
}): Promise<ActionResult> {
  const { user, ctx, decision } = await getInventoryAccess();
  if (!decision.allowed) return { error: decision.message };
  if (!decision.canManageSuppliers) return { error: "ต้องมีสิทธิ์จัดการเมนูจึงจะตั้งค่าคลังได้" };
  if (!UUID_RE.test(input.ingredientId)) return { error: "ข้อมูลวัตถุดิบไม่ถูกต้อง" };
  if (input.reorderPoint !== null && (!finite(input.reorderPoint) || input.reorderPoint < 0 || input.reorderPoint > MAX_QTY)) {
    return { error: "จุดสั่งซื้อไม่ถูกต้อง" };
  }
  if (!Number.isInteger(input.safetyDays) || input.safetyDays < 0 || input.safetyDays > 60) return { error: "วันสำรองต้องเป็น 0–60 วัน" };
  if (input.defaultSupplierId !== null && !UUID_RE.test(input.defaultSupplierId)) return { error: "ข้อมูลผู้ขายไม่ถูกต้อง" };

  const result = await saveIngredientInventorySettings(ctx.storeId, input.ingredientId, input);
  await logInventory({
    action: "saveIngredientInventorySettings",
    ok: !result.error,
    message: result.error ? `ตั้งค่าคลังวัตถุดิบไม่สำเร็จ: ${result.error}` : "ตั้งค่าจุดสั่งซื้อ/ผู้ขายประจำ",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { ...input },
  });
  if (result.error) return { error: result.error };
  revalidateInventory();
  return { error: null };
}

export async function saveSupplierAction(input: SupplierInput): Promise<ActionResult> {
  const { user, ctx, decision } = await getInventoryAccess();
  if (!decision.allowed) return { error: decision.message };
  if (!decision.canManageSuppliers) return { error: "ต้องมีสิทธิ์จัดการเมนูจึงจะแก้ทะเบียนผู้ขายได้" };
  const validated = validateSupplier(input);
  if ("error" in validated) return { error: validated.error };

  // หน้าคลังไม่มีสิทธิ์ตั้งช่องฝากขาย (Enterprise) — ตัดทิ้งเสมอ ค่าเดิมใน DB ไม่ถูกแตะ
  const result = await saveSupplier(
    { organizationId: ctx.organizationId, storeId: ctx.storeId },
    { ...validated.value, consignment: null },
  );
  await logInventory({
    action: "saveSupplier",
    ok: !result.error,
    message: result.error ? `บันทึกผู้ขายไม่สำเร็จ: ${result.error}` : input.id ? "แก้ผู้ขาย" : "เพิ่มผู้ขาย",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { supplierId: result.data?.id ?? input.id ?? null, isActive: validated.value.isActive },
  });
  if (result.error) return { error: result.error };
  revalidateInventory();
  return { error: null };
}
