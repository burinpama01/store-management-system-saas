"use server";

/**
 * แอ็กชันงานประจำของสินค้าซื้อขาด/ฝากขาย (C1–C4)
 * ทุกแอ็กชัน: ด่านสิทธิ์ → ตรวจข้อมูล → RPC (DB ตรวจซ้ำ) → log ทั้งสำเร็จและล้มเหลว
 */
import { revalidatePath } from "next/cache";
import { getConsignmentAccess, getDailyCloseConsignmentAccess } from "@/modules/consignment/access";
import {
  adjustLot,
  assignFlavor,
  getSettlementPreview,
  listDailyCycleSupplierIds,
  receiveLots,
  saveProductSourcing,
  settle,
} from "@/modules/consignment/repository";
import type {
  LotAdjustKind,
  PayoutMethod,
  ProductSourcingInput,
  ReceiveLine,
  SettlementPreview,
  SettleTrigger,
} from "@/modules/consignment/types";
import { isUuid, validateAdjust, validateReceive, validateSourcing } from "@/modules/consignment/validate";
import { getCashOnHand } from "@/modules/hr/advanced/repository";
import { logSystemEvent } from "@/modules/system/event-log";

type ActionResult = { error: string | null };

async function log(input: {
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

function revalidateAll() {
  revalidatePath("/consignment");
  revalidatePath("/consignment/products");
  revalidatePath("/consignment/receive");
  revalidatePath("/consignment/report");
  revalidatePath("/catalog");
  revalidatePath("/pos");
}

async function operator() {
  const access = await getConsignmentAccess();
  if (!access.decision.allowed) return { error: access.decision.message } as const;
  if (!access.decision.canOperate) return { error: "สาขานี้ยังไม่ได้เปิดระบบซื้อขาด/ฝากขาย" } as const;
  return access;
}

/** จ่ายเงินสดต้องไม่เกินเงินในลิ้นชัก (แบบเดียวกับเบิกเงินพนักงาน) */
async function cashShortage(storeId: string, amount: number): Promise<string | null> {
  if (amount <= 0) return null;
  try {
    const cash = await getCashOnHand(storeId);
    if (!cash.sessionOpen) return "ยังไม่ได้เปิดรอบเงินสด — เปิดรอบก่อน หรือเลือกโอน";
    if (cash.amount < amount) return "เงินสดในลิ้นชักไม่พอ — เลือกโอน หรือค้างไว้ก่อน";
    return null;
  } catch {
    return "อ่านเงินสดในลิ้นชักไม่สำเร็จ ลองใหม่อีกครั้ง";
  }
}

// ---------- C1 ----------
export async function saveProductSourcingAction(input: ProductSourcingInput): Promise<ActionResult> {
  const access = await operator();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  const validated = validateSourcing(input);
  if ("error" in validated) return { error: validated.error };
  const result = await saveProductSourcing(validated.value);
  await log({
    action: "saveProductSourcing",
    ok: !result.error,
    message: result.error ? `ตั้งที่มาสินค้าไม่สำเร็จ: ${result.error}` : `ตั้งที่มาสินค้า: ${validated.value.mode}`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { productId: validated.value.productId, mode: validated.value.mode, supplierId: validated.value.supplierId },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null };
}

// ---------- C2 ----------
export async function receiveLotsAction(input: {
  supplierId: string;
  mode: "resale" | "consignment";
  lines: ReceiveLine[];
  expiresOn: string | null;
  note: string | null;
  paymentMethod: PayoutMethod | null;
}): Promise<ActionResult & { total?: number }> {
  const access = await operator();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  const validated = validateReceive(input);
  if ("error" in validated) return { error: validated.error };
  if (validated.value.mode === "resale" && validated.value.paymentMethod === "cash") {
    const short = await cashShortage(ctx.storeId, validated.value.total);
    if (short) return { error: short };
  }
  const { total: _total, ...payload } = validated.value;
  void _total;
  const result = await receiveLots(payload);
  await log({
    action: "receiveLots",
    ok: !result.error,
    message: result.error
      ? `รับของไม่สำเร็จ: ${result.error}`
      : `รับของ ${validated.value.lines.length} รายการ (${validated.value.mode === "resale" ? "ซื้อขาด" : "ฝากขาย"})`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: {
      supplierId: validated.value.supplierId,
      mode: validated.value.mode,
      lines: validated.value.lines.length,
      total: result.data?.total ?? validated.value.total,
      transactionId: result.data?.transactionId ?? null,
    },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  revalidatePath("/accounting");
  return { error: null, total: result.data?.total };
}

export async function assignFlavorAction(movementId: string, optionId: string): Promise<ActionResult> {
  const access = await operator();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  if (!isUuid(movementId) || !isUuid(optionId)) return { error: "ข้อมูลไม่ถูกต้อง" };
  const result = await assignFlavor(movementId, optionId);
  await log({
    action: "assignFlavor",
    ok: !result.error,
    message: result.error ? `เลือกรสย้อนหลังไม่สำเร็จ: ${result.error}` : `เลือกรสย้อนหลัง ${result.data} ชิ้น`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { movementId, optionId },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null };
}

// ---------- C3 ----------
export async function getSettlementPreviewAction(supplierId: string): Promise<{ data: SettlementPreview | null; error: string | null }> {
  const access = await getConsignmentAccess();
  if (!access.decision.allowed) return { data: null, error: access.decision.message };
  if (!isUuid(supplierId)) return { data: null, error: "ข้อมูลไม่ถูกต้อง" };
  return getSettlementPreview(supplierId);
}

async function doSettle(input: {
  supplierId: string;
  method: PayoutMethod;
  trigger: SettleTrigger;
  expectedTotal: number;
  note: string | null;
  storeId: string;
  organizationId: string;
  actorUserId: string;
}): Promise<ActionResult & { paid?: number }> {
  if (!isUuid(input.supplierId)) return { error: "ข้อมูลไม่ถูกต้อง" };
  if (input.method !== "cash" && input.method !== "transfer") return { error: "เลือกจ่ายเงินสดหรือโอน" };
  if (typeof input.expectedTotal !== "number" || !Number.isFinite(input.expectedTotal)) return { error: "ข้อมูลยอดไม่ถูกต้อง" };
  if (input.method === "cash") {
    const short = await cashShortage(input.storeId, input.expectedTotal);
    if (short) return { error: short };
  }
  const note = (input.note ?? "").trim().slice(0, 300) || null;
  const result = await settle({ supplierId: input.supplierId, method: input.method, trigger: input.trigger, expectedTotal: input.expectedTotal, note });
  await log({
    action: "settle",
    ok: !result.error,
    message: result.error
      ? `เคลียร์เงินเจ้าของไม่สำเร็จ: ${result.error}`
      : `เคลียร์เงินเจ้าของ ${result.data?.paid ?? 0} บาท (${input.method === "cash" ? "เงินสด" : "โอน"})`,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: {
      supplierId: input.supplierId,
      trigger: input.trigger,
      method: input.method,
      expectedTotal: input.expectedTotal,
      settlementId: result.data?.settlementId ?? null,
      carryOut: result.data?.carryOut ?? null,
    },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  revalidatePath("/accounting");
  return { error: null, paid: result.data?.paid };
}

/** เคลียร์จากหน้าฝากขาย (manual) หรือขั้นเติมของ (restock) — ผู้จัดการขึ้นไป */
export async function settleAction(input: {
  supplierId: string;
  method: PayoutMethod;
  trigger: "manual" | "restock";
  expectedTotal: number;
  note: string | null;
}): Promise<ActionResult & { paid?: number }> {
  const access = await operator();
  if ("error" in access) return { error: access.error ?? null };
  if (input.trigger !== "manual" && input.trigger !== "restock") return { error: "ข้อมูลไม่ถูกต้อง" };
  return doSettle({ ...input, storeId: access.ctx.storeId, organizationId: access.ctx.organizationId, actorUserId: access.user.id });
}

/** ปิดรอบเงินสด: ยอดฝากขายของเจ้าของที่เลือก "เคลียร์ทุกวัน" */
export async function getDailyCloseConsignmentAction(): Promise<{
  data: Array<Pick<SettlementPreview, "supplierId" | "name" | "payoutMethod" | "payoutAccount" | "total" | "pendingRows">> | null;
  error: string | null;
}> {
  const access = await getDailyCloseConsignmentAccess();
  if (!access.allowed) return { data: null, error: null };
  const ids = await listDailyCycleSupplierIds(access.ctx.storeId);
  if (ids.error) return { data: null, error: "อ่านรายชื่อเจ้าของสินค้าไม่สำเร็จ" };
  const previews = await Promise.all((ids.data ?? []).map((id) => getSettlementPreview(id)));
  const rows = previews
    .map((p) => p.data)
    .filter((p): p is SettlementPreview => !!p && (p.total !== 0 || p.ownerDue !== 0 || p.clawback !== 0))
    .map((p) => ({ supplierId: p.supplierId, name: p.name, payoutMethod: p.payoutMethod, payoutAccount: p.payoutAccount, total: p.total, pendingRows: p.pendingRows }));
  return { data: rows, error: null };
}

export async function settleAtDailyCloseAction(supplierId: string, expectedTotal: number): Promise<ActionResult & { paid?: number }> {
  const access = await getDailyCloseConsignmentAccess();
  if (!access.allowed) return { error: "ไม่มีสิทธิ์แยกเงินฝากขาย" };
  return doSettle({
    supplierId,
    method: "cash",
    trigger: "daily_close",
    expectedTotal,
    note: "แยกเงินตอนปิดรอบ",
    storeId: access.ctx.storeId,
    organizationId: access.ctx.organizationId,
    actorUserId: access.user.id,
  });
}

// ---------- C4 ----------
export async function adjustLotAction(input: { lotId: string; kind: LotAdjustKind; qty: number; note: string | null }): Promise<ActionResult> {
  const access = await operator();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  const validated = validateAdjust(input);
  if ("error" in validated) return { error: validated.error };
  const result = await adjustLot(validated.value);
  await log({
    action: "adjustLot",
    ok: !result.error,
    message: result.error ? `ปรับล็อตไม่สำเร็จ: ${result.error}` : `ปรับล็อต (${validated.value.kind}) ${validated.value.qty} ชิ้น`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: validated.value,
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null };
}
