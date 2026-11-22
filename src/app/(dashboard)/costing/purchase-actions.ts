"use server";

/** บิลซื้อ (A1): ด่าน getInventoryAccess → ตรวจข้อมูล → RPC → log ทั้งสำเร็จและล้มเหลว */
import { revalidatePath } from "next/cache";
import { getCashOnHand } from "@/modules/hr/advanced/repository";
import { getInventoryAccess } from "@/modules/inventory/access";
import { payPurchaseBill, postPurchaseBill, voidPurchaseBill } from "@/modules/purchasing/repository";
import type { PayMethod, PurchaseBillInput } from "@/modules/purchasing/types";
import { validateBill } from "@/modules/purchasing/validate";
import { logSystemEvent } from "@/modules/system/event-log";

type ActionResult = { error: string | null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    source: "purchasing",
    action: input.action,
    message: input.message,
    organizationId: input.organizationId,
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    context: input.context,
  }).catch(() => undefined);
}

function revalidateAll() {
  revalidatePath("/costing/purchases");
  revalidatePath("/costing/inventory");
  revalidatePath("/costing/ingredients");
  revalidatePath("/costing/menu");
  revalidatePath("/accounting");
}

async function editor() {
  const access = await getInventoryAccess();
  if (!access.decision.allowed) return { error: access.decision.message } as const;
  if (!access.decision.enabled) return { error: "สาขานี้ยังไม่ได้เปิดคลังวัตถุดิบ — เปิดที่แท็บ คลังวัตถุดิบ" } as const;
  if (!access.decision.canEdit) return { error: "ต้องมีสิทธิ์จัดการเมนูจึงจะบันทึกบิลซื้อได้" } as const;
  return access;
}

/** เงินสดต้องไม่เกินเงินในลิ้นชัก (DB ตรวจซ้ำ) — เช็กก่อนเพื่อข้อความที่ชัด */
async function cashShortage(storeId: string, amount: number): Promise<string | null> {
  if (amount <= 0) return null;
  try {
    const cash = await getCashOnHand(storeId);
    if (!cash.sessionOpen) return "ยังไม่ได้เปิดรอบเงินสด — เปิดรอบก่อน หรือเลือกโอน/ค้างจ่าย";
    if (cash.amount < amount) return "เงินสดในลิ้นชักไม่พอ — เลือกโอน หรือค้างจ่าย";
    return null;
  } catch {
    return "อ่านเงินสดในลิ้นชักไม่สำเร็จ ลองใหม่อีกครั้ง";
  }
}

export async function postPurchaseBillAction(input: PurchaseBillInput): Promise<ActionResult & { negativeResets?: number }> {
  const access = await editor();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  const validated = validateBill(input);
  if ("error" in validated) return { error: validated.error };
  const bill = validated.value;
  if (bill.paymentStatus === "paid" && bill.paymentMethod === "cash") {
    const short = await cashShortage(ctx.storeId, bill.total);
    if (short) return { error: short };
  }
  const result = await postPurchaseBill(ctx.storeId, bill);
  await log({
    action: "postPurchaseBill",
    ok: !result.error,
    message: result.error
      ? `บันทึกบิลซื้อไม่สำเร็จ: ${result.error}`
      : `บันทึกบิลซื้อ ${bill.total} บาท (${bill.lines.length} บรรทัด, ${bill.paymentStatus === "paid" ? bill.paymentMethod : "ค้างจ่าย"})`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: {
      billId: result.data?.billId ?? null,
      supplierId: bill.supplierId,
      total: bill.total,
      lines: bill.lines.length,
      source: bill.source,
      negativeResets: result.data?.negativeResets ?? null,
    },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null, negativeResets: result.data?.negativeResets };
}

export async function payPurchaseBillAction(billId: string, method: PayMethod, amount: number): Promise<ActionResult> {
  const access = await editor();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  if (!UUID_RE.test(billId) || (method !== "cash" && method !== "transfer")) return { error: "ข้อมูลไม่ถูกต้อง" };
  if (method === "cash") {
    const short = await cashShortage(ctx.storeId, amount);
    if (short) return { error: short };
  }
  const result = await payPurchaseBill(billId, method);
  await log({
    action: "payPurchaseBill",
    ok: !result.error,
    message: result.error ? `จ่ายบิลซื้อไม่สำเร็จ: ${result.error}` : `จ่ายบิลซื้อ ${result.data} บาท (${method})`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { billId, method },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null };
}

export async function voidPurchaseBillAction(billId: string, reason: string): Promise<ActionResult> {
  const access = await editor();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  const cleaned = (reason ?? "").trim().slice(0, 300);
  if (!UUID_RE.test(billId)) return { error: "ข้อมูลไม่ถูกต้อง" };
  if (!cleaned) return { error: "ใส่เหตุผลที่ยกเลิก" };
  const result = await voidPurchaseBill(billId, cleaned);
  await log({
    action: "voidPurchaseBill",
    ok: !result.error,
    message: result.error ? `ยกเลิกบิลซื้อไม่สำเร็จ: ${result.error}` : `ยกเลิกบิลซื้อ (คืนเงิน ${result.data} บาท)`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { billId, reason: cleaned },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null };
}
