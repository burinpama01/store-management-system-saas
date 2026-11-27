"use server";

import { revalidatePath } from "next/cache";
import { getCostingAccess } from "@/modules/costing/access";
import { isCostType, type BudgetKind, type CostType } from "@/modules/costing/break-even";
import {
  deleteCostBudget,
  saveBreakEvenSettings,
  saveCostBudget,
  setCategoryCostType,
} from "@/modules/costing/break-even-repository";
import { loadCostingWorkspace } from "@/modules/costing/repository";
import { logSystemEvent } from "@/modules/system/event-log";

type ActionResult = { error: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** log ทุกการแก้ (สำเร็จ/ล้มเหลว) — ไม่เก็บจำนวนเงินหรือชื่อรายการ */
async function logBreakEven(input: {
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
    source: "costing.break_even",
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

function revalidate() {
  revalidatePath("/costing");
  revalidatePath("/costing/break-even");
}

export async function saveCostBudgetAction(input: {
  id: string | null;
  kind: BudgetKind;
  costType: CostType;
  name: string;
  amount: number;
  usefulLifeMonths: number | null;
  isActive: boolean;
}): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) return { error: "ชื่อรายการต้องมี 1–80 ตัวอักษร" };
  if (input.kind !== "monthly" && input.kind !== "startup") return { error: "ประเภทรายการไม่ถูกต้อง" };
  if (!isCostType(input.costType)) return { error: "ประเภทต้นทุนไม่ถูกต้อง" };
  if (!finite(input.amount) || input.amount < 0 || input.amount > 100_000_000) return { error: "จำนวนเงินไม่ถูกต้อง" };
  if (input.kind === "startup" && input.usefulLifeMonths !== null) {
    if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths < 1 || input.usefulLifeMonths > 600) {
      return { error: "อายุใช้งานต้องเป็นจำนวนเดือน 1–600" };
    }
  }
  if (input.id !== null && !UUID_RE.test(input.id)) return { error: "ข้อมูลรายการไม่ถูกต้อง" };
  if (typeof input.isActive !== "boolean") return { error: "ข้อมูลรายการไม่ถูกต้อง" };

  const scope = { organizationId: access.ctx.organizationId, storeId: access.ctx.storeId };
  const result = await saveCostBudget(scope, { ...input, name, usefulLifeMonths: input.kind === "startup" ? input.usefulLifeMonths : null });
  await logBreakEven({
    action: "saveCostBudget",
    ok: !result.error,
    message: result.error ? `บันทึกต้นทุนคงที่ไม่สำเร็จ: ${result.error}` : input.id ? "แก้รายการต้นทุนคงที่" : "เพิ่มรายการต้นทุนคงที่",
    ...scope,
    actorUserId: access.user.id,
    context: { budgetId: result.id ?? input.id, kind: input.kind, costType: input.costType, isActive: input.isActive },
  });
  if (result.error) return { error: result.error };
  revalidate();
  return { error: null };
}

export async function deleteCostBudgetAction(id: string): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (!UUID_RE.test(id)) return { error: "ข้อมูลรายการไม่ถูกต้อง" };
  const result = await deleteCostBudget(access.ctx.storeId, id);
  await logBreakEven({
    action: "deleteCostBudget",
    ok: !result.error,
    message: result.error ? `ลบรายการต้นทุนไม่สำเร็จ: ${result.error}` : "ลบรายการต้นทุนคงที่",
    organizationId: access.ctx.organizationId,
    storeId: access.ctx.storeId,
    actorUserId: access.user.id,
    context: { budgetId: id },
  });
  if (result.error) return result;
  revalidate();
  return { error: null };
}

export async function saveBreakEvenSettingsAction(input: {
  openDaysPerMonth: number;
  targetProfitMonthly: number;
  otherVariablePct: number;
}): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (!Number.isInteger(input.openDaysPerMonth) || input.openDaysPerMonth < 1 || input.openDaysPerMonth > 31) return { error: "วันเปิดร้านต้องเป็น 1–31 วัน" };
  if (!finite(input.targetProfitMonthly) || input.targetProfitMonthly < 0 || input.targetProfitMonthly > 100_000_000) return { error: "เป้ากำไรไม่ถูกต้อง" };
  if (!finite(input.otherVariablePct) || input.otherVariablePct < 0 || input.otherVariablePct >= 100) return { error: "ต้นทุนผันแปรอื่นต้องอยู่ระหว่าง 0–99%" };

  const scope = { organizationId: access.ctx.organizationId, storeId: access.ctx.storeId };
  const workspace = await loadCostingWorkspace(access.ctx.storeId);
  if (!workspace.data) return { error: workspace.error ?? "โหลดค่าตั้งต้นทุนไม่สำเร็จ" };
  const result = await saveBreakEvenSettings(scope, input, workspace.data.settings);
  await logBreakEven({
    action: "saveBreakEvenSettings",
    ok: !result.error,
    message: result.error ? `บันทึกค่าตั้งจุดคุ้มทุนไม่สำเร็จ: ${result.error}` : "บันทึกค่าตั้งจุดคุ้มทุน",
    ...scope,
    actorUserId: access.user.id,
    context: { openDaysPerMonth: input.openDaysPerMonth, otherVariablePct: input.otherVariablePct },
  });
  if (result.error) return result;
  revalidate();
  revalidatePath("/costing/menu");
  return { error: null };
}

export async function setCategoryCostTypeAction(input: { categoryId: string; costType: CostType | null }): Promise<ActionResult> {
  const { access, error } = await requireEditor();
  if (!access) return { error };
  if (!UUID_RE.test(input.categoryId)) return { error: "ข้อมูลหมวดไม่ถูกต้อง" };
  if (input.costType !== null && !isCostType(input.costType)) return { error: "ประเภทต้นทุนไม่ถูกต้อง" };
  const result = await setCategoryCostType(access.ctx.storeId, input.categoryId, input.costType);
  await logBreakEven({
    action: "setCategoryCostType",
    ok: !result.error,
    message: result.error ? `จับคู่หมวดรายจ่ายไม่สำเร็จ: ${result.error}` : "จับคู่หมวดรายจ่ายกับประเภทต้นทุน",
    organizationId: access.ctx.organizationId,
    storeId: access.ctx.storeId,
    actorUserId: access.user.id,
    context: input,
  });
  if (result.error) return result;
  revalidate();
  return { error: null };
}
