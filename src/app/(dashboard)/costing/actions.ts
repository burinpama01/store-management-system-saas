"use server";

import { revalidatePath } from "next/cache";
import { allocationSum, validateAllocation } from "@/modules/costing/allocation";
import { getCostingAccess } from "@/modules/costing/access";
import {
  clearProductAllocation,
  deleteIngredient,
  insertAllocationTemplate,
  saveIngredient,
  saveMenuCosting,
  saveOptionRecipe,
  saveStoreCostSettings,
} from "@/modules/costing/repository";
import type { AllocationPcts, IngredientInput, PriceRounding } from "@/modules/costing/types";
import { logSystemEvent } from "@/modules/system/event-log";

type ActionResult = { error: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUNDING: readonly PriceRounding[] = ["none", "ceil_1", "ceil_5", "ceil_10"];
// สูตรหลัก + บรรทัดของตัวเลือกเสริม (ต้องตรงกับเพดานใน costing_save_menu)
const MAX_RECIPE_LINES = 120;

/** ทุกการแก้ต้นทุนต้องทิ้ง log ทั้งสำเร็จและล้มเหลว (กฎโปรเจกต์: ห้ามสำเร็จแบบเงียบ) */
async function logCosting(input: {
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
    source: "costing",
    action: input.action,
    message: input.message,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: input.context,
  }).catch(() => undefined);
}

async function requireEditor() {
  const access = await getCostingAccess();
  if (!access.decision.allowed) return { access: null, error: access.decision.message };
  if (!access.decision.canEdit) return { access: null, error: "ต้องมีสิทธิ์จัดการเมนูจึงจะแก้ต้นทุนได้" };
  return { access, error: null };
}

function revalidateCosting() {
  revalidatePath("/costing");
  revalidatePath("/costing/menu");
  revalidatePath("/costing/ingredients");
}

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);

export async function saveIngredientAction(input: IngredientInput): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  const name = input.name?.trim() ?? "";
  if (!name || name.length > 80) return { error: "ชื่อวัตถุดิบต้องมี 1–80 ตัวอักษร" };
  const category = typeof input.category === "string" ? input.category.trim() : "";
  if (category.length > 40) return { error: "ชื่อหมวดต้องไม่เกิน 40 ตัวอักษร" };
  if (!input.purchaseUnit?.trim() || !input.usageUnit?.trim()) return { error: "กรุณาระบุหน่วยซื้อและหน่วยที่ใช้" };
  if (!finite(input.usagePerPurchase) || input.usagePerPurchase <= 0) return { error: "ปริมาณที่ใช้ได้ต่อการซื้อต้องมากกว่า 0" };
  if (!finite(input.purchasePrice) || input.purchasePrice < 0 || input.purchasePrice > 10_000_000) return { error: "ราคาซื้อไม่ถูกต้อง" };
  if (!finite(input.yieldPct) || input.yieldPct <= 0 || input.yieldPct > 100) return { error: "ส่วนที่ใช้ได้จริงต้องอยู่ระหว่าง 1–100%" };
  if (input.id && !UUID_RE.test(input.id)) return { error: "ข้อมูลวัตถุดิบไม่ถูกต้อง" };

  const scope = { organizationId: access.ctx.organizationId, storeId: access.ctx.storeId };
  const result = await saveIngredient(scope, { ...input, name, category: category || null }, access.user.id);
  await logCosting({
    action: "saveIngredient",
    ok: !result.error,
    message: result.error ? `บันทึกวัตถุดิบไม่สำเร็จ: ${result.error}` : input.id ? "แก้วัตถุดิบ" : "เพิ่มวัตถุดิบ",
    ...scope,
    actorUserId: access.user.id,
    context: { ingredientId: result.data?.id ?? input.id ?? null, priceChanged: result.data?.priceChanged ?? null },
  });
  if (result.error) return { error: result.error };
  revalidateCosting();
  return { error: null };
}

export async function deleteIngredientAction(ingredientId: string): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (!UUID_RE.test(ingredientId)) return { error: "ข้อมูลวัตถุดิบไม่ถูกต้อง" };
  const result = await deleteIngredient(access.ctx.storeId, ingredientId);
  await logCosting({
    action: "deleteIngredient",
    ok: !result.error,
    message: result.error ? `ลบวัตถุดิบไม่สำเร็จ: ${result.error}` : "ลบวัตถุดิบ",
    organizationId: access.ctx.organizationId,
    storeId: access.ctx.storeId,
    actorUserId: access.user.id,
    context: { ingredientId },
  });
  if (result.error) return result;
  revalidateCosting();
  return { error: null };
}

export async function saveMenuCostingAction(input: {
  productId: string;
  lines: Array<{ variantId: string | null; modifierOptionId: string | null; ingredientId: string; quantity: number }>;
  packagingCost: number;
  targetFoodCostPct: number | null;
}): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (!UUID_RE.test(input.productId)) return { error: "ข้อมูลเมนูไม่ถูกต้อง" };
  if (!Array.isArray(input.lines) || input.lines.length > MAX_RECIPE_LINES) return { error: `สูตรมีได้ไม่เกิน ${MAX_RECIPE_LINES} บรรทัด` };
  for (const line of input.lines) {
    const modifierOptionId = line.modifierOptionId ?? null;
    if (
      !UUID_RE.test(line.ingredientId) ||
      (line.variantId !== null && !UUID_RE.test(line.variantId)) ||
      (modifierOptionId !== null && !UUID_RE.test(modifierOptionId))
    ) {
      return { error: "ข้อมูลสูตรไม่ถูกต้อง" };
    }
    if (line.variantId !== null && modifierOptionId !== null) return { error: "บรรทัดสูตรผูกได้ทั้ง ตัวเลือกสินค้า หรือ ตัวเลือกเสริม อย่างใดอย่างหนึ่ง" };
    if (!finite(line.quantity) || line.quantity <= 0 || line.quantity > 1_000_000) return { error: "ปริมาณในสูตรต้องมากกว่า 0" };
  }
  // วัตถุดิบเดียวกันในตัวเลือกเดียวกันห้ามซ้ำ (ต้นทุนจะนับสองเท่า) — DB มี unique index กันซ้ำอีกชั้น
  const lineKeys = input.lines.map((line) => `${line.ingredientId}:${line.variantId ?? "all"}:${line.modifierOptionId ?? "base"}`);
  if (new Set(lineKeys).size !== lineKeys.length) return { error: "วัตถุดิบในสูตรซ้ำกัน — รวมเป็นบรรทัดเดียว" };
  if (!finite(input.packagingCost) || input.packagingCost < 0 || input.packagingCost > 100_000) return { error: "ค่าบรรจุภัณฑ์ไม่ถูกต้อง" };
  if (input.targetFoodCostPct !== null && (!finite(input.targetFoodCostPct) || input.targetFoodCostPct <= 0 || input.targetFoodCostPct >= 100)) {
    return { error: "เป้า food cost ต้องอยู่ระหว่าง 1–99%" };
  }

  const scope = { organizationId: access.ctx.organizationId, storeId: access.ctx.storeId };
  // ธุรกรรมเดียว + RLS ตรวจซ้ำว่าเมนู/วัตถุดิบ/ตัวเลือกเป็นของร้านนี้ (with check ใน migration)
  const saved = await saveMenuCosting({
    ...input,
    lines: input.lines.map((line) => ({ ...line, modifierOptionId: line.modifierOptionId ?? null })),
  });
  const failure = saved.error;
  await logCosting({
    action: "saveMenuCosting",
    ok: !failure,
    message: failure ? `บันทึกสูตรเมนูไม่สำเร็จ: ${failure}` : "บันทึกสูตรและต้นทุนเมนู",
    ...scope,
    actorUserId: access.user.id,
    context: {
      productId: input.productId,
      lineCount: input.lines.length,
      optionLineCount: input.lines.filter((line) => line.modifierOptionId).length,
    },
  });
  if (failure) return { error: failure };
  revalidateCosting();
  return { error: null };
}

const MAX_OPTION_LINES = 30;

/** วัตถุดิบที่บวกเพิ่มเมื่อเลือกตัวเลือกเสริม — เรียกจากหน้าแก้เมนู (/catalog) */
export async function saveOptionRecipeAction(input: {
  optionId: string;
  lines: Array<{ ingredientId: string; quantity: number }>;
  applySameName: boolean;
}): Promise<ActionResult & { optionCount?: number }> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (!UUID_RE.test(input.optionId)) return { error: "ข้อมูลตัวเลือกไม่ถูกต้อง" };
  if (!Array.isArray(input.lines) || input.lines.length > MAX_OPTION_LINES) return { error: `ตัวเลือกหนึ่งมีวัตถุดิบได้ไม่เกิน ${MAX_OPTION_LINES} บรรทัด` };
  for (const line of input.lines) {
    if (!UUID_RE.test(line.ingredientId)) return { error: "ข้อมูลสูตรไม่ถูกต้อง" };
    if (!finite(line.quantity) || line.quantity <= 0 || line.quantity > 1_000_000) return { error: "ปริมาณต้องมากกว่า 0" };
  }
  if (new Set(input.lines.map((line) => line.ingredientId)).size !== input.lines.length) return { error: "วัตถุดิบซ้ำกัน — รวมเป็นบรรทัดเดียว" };

  const scope = { organizationId: access.ctx.organizationId, storeId: access.ctx.storeId };
  const applySameName = input.applySameName === true;
  const result = await saveOptionRecipe({ optionId: input.optionId, lines: input.lines, applySameName });
  await logCosting({
    action: "saveOptionRecipe",
    ok: !result.error,
    message: result.error ? `บันทึกวัตถุดิบของตัวเลือกไม่สำเร็จ: ${result.error}` : "บันทึกวัตถุดิบของตัวเลือกเสริม",
    ...scope,
    actorUserId: access.user.id,
    context: { optionId: input.optionId, lineCount: input.lines.length, applySameName, optionCount: result.data },
  });
  if (result.error) return { error: result.error };
  revalidateCosting();
  revalidatePath("/catalog");
  return { error: null, optionCount: result.data ?? 0 };
}

export async function saveAllocationAction(input: { productId: string | null; pcts: AllocationPcts }): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (input.productId !== null && !UUID_RE.test(input.productId)) return { error: "ข้อมูลเมนูไม่ถูกต้อง" };
  const invalid = validateAllocation(input.pcts);
  if (invalid) return { error: invalid };
  const scope = { organizationId: access.ctx.organizationId, storeId: access.ctx.storeId };
  const result = await insertAllocationTemplate(scope, input.productId, input.pcts, access.user.id);
  await logCosting({
    action: "saveAllocation",
    ok: !result.error,
    message: result.error ? `บันทึกสัดส่วนไม่สำเร็จ: ${result.error}` : input.productId ? "ตั้งสัดส่วนเฉพาะเมนู" : "ตั้งสัดส่วนของร้าน",
    ...scope,
    actorUserId: access.user.id,
    context: { productId: input.productId, pcts: input.pcts, sum: allocationSum(input.pcts) },
  });
  if (result.error) return result;
  revalidateCosting();
  return { error: null };
}

export async function clearProductAllocationAction(productId: string): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (!UUID_RE.test(productId)) return { error: "ข้อมูลเมนูไม่ถูกต้อง" };
  const result = await clearProductAllocation(
    { organizationId: access.ctx.organizationId, storeId: access.ctx.storeId },
    productId,
    access.user.id,
  );
  await logCosting({
    action: "clearProductAllocation",
    ok: !result.error,
    message: result.error ? `ล้างสัดส่วนเมนูไม่สำเร็จ: ${result.error}` : "กลับไปใช้สัดส่วนของร้าน",
    organizationId: access.ctx.organizationId,
    storeId: access.ctx.storeId,
    actorUserId: access.user.id,
    context: { productId },
  });
  if (result.error) return result;
  revalidateCosting();
  return { error: null };
}

export async function saveCostSettingsAction(input: { targetFoodCostPct: number; priceRounding: PriceRounding }): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (!finite(input.targetFoodCostPct) || input.targetFoodCostPct <= 0 || input.targetFoodCostPct >= 100) {
    return { error: "เป้า food cost ต้องอยู่ระหว่าง 1–99%" };
  }
  if (!ROUNDING.includes(input.priceRounding)) return { error: "รูปแบบการปัดราคาไม่ถูกต้อง" };
  const scope = { organizationId: access.ctx.organizationId, storeId: access.ctx.storeId };
  const result = await saveStoreCostSettings(scope, input);
  await logCosting({
    action: "saveCostSettings",
    ok: !result.error,
    message: result.error ? `บันทึกค่าตั้งต้นทุนไม่สำเร็จ: ${result.error}` : "บันทึกค่าตั้งต้นทุนของร้าน",
    ...scope,
    actorUserId: access.user.id,
    context: input,
  });
  if (result.error) return result;
  revalidateCosting();
  return { error: null };
}
