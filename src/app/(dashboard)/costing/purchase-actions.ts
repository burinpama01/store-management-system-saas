"use server";

/**
 * บิลซื้อ (A1 + v5): ด่าน → ตรวจข้อมูล → RPC → log ทั้งสำเร็จและล้มเหลว
 * - ส่งบิล/อัปโหลดรูป: พนักงานทุกระดับ (getPurchaseSubmitAccess) · บิลเขียนมือ/ของพนักงาน = รออนุมัติ
 * - อนุมัติ/ไม่อนุมัติ/รับเงินคืน/จ่าย/ยกเลิก: ผู้จัดการขึ้นไป (getInventoryAccess)
 */
import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { AI_DEFAULT_MODEL, isAiEnabled } from "@/modules/ai/gateway";
import { MAX_IMAGE_BYTES, MIN_IMAGE_BYTES, sniffImageMime } from "@/modules/ai/menu-scan";
import { reserveQuota, settleUsage } from "@/modules/ai/quota";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature } from "@/modules/billing/types";
import { getCashOnHand } from "@/modules/hr/advanced/repository";
import { BILL_SCAN_MAX_OUTPUT_TOKENS, buildScannedDraft, normalizeItemName, type ScannedBillDraft } from "@/modules/purchasing/bill-scan";
import { extractBillFromImage } from "@/modules/purchasing/bill-scan-ai";
import { getInventoryAccess } from "@/modules/inventory/access";
import { getPurchaseSubmitAccess } from "@/modules/purchasing/access";
import {
  approvePurchaseBill,
  downloadEvidenceImage,
  getVisibleEvidenceImage,
  loadScanContext,
  payPurchaseBill,
  postPurchaseBill,
  PURCHASE_EVIDENCE_BUCKET,
  recoverPurchaseBill,
  registerPurchaseImage,
  rejectPurchaseBill,
  voidPurchaseBill,
} from "@/modules/purchasing/repository";
import type { PayMethod, PurchaseBillInput } from "@/modules/purchasing/types";
import { validateBill } from "@/modules/purchasing/validate";
import { logSystemEvent } from "@/modules/system/event-log";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

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

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // หลังย่อฝั่งเครื่องแล้ว (Vercel รับ body ได้ ~4.5MB)

function revalidateAll() {
  revalidatePath("/costing/purchases");
  revalidatePath("/costing/purchases/evidence");
  revalidatePath("/purchase-bills");
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

/** อัปโหลดรูปหลักฐาน 1 รูป → เก็บใน bucket ส่วนตัว + ลงทะเบียน (ทุกรูปเก็บไว้ ไม่ลบ) */
export async function uploadPurchaseImageAction(formData: FormData): Promise<ActionResult & { imageId?: string }> {
  const access = await getPurchaseSubmitAccess();
  if (!access.decision.allowed) return { error: access.decision.message };
  const { user, ctx } = access;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "ไม่พบไฟล์รูป" };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "ไฟล์รูปใหญ่เกินไป" };
  if (file.type && !file.type.startsWith("image/")) return { error: "แนบได้เฉพาะไฟล์รูป" };

  let jpeg: Buffer;
  try {
    // ด้านยาว 2000px คุณภาพ 82 — ยังอ่านตัวเลขในบิลได้ชัด สำหรับยื่นภาษี
    jpeg = await sharp(Buffer.from(await file.arrayBuffer()))
      .rotate()
      .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    return { error: "อ่านไฟล์รูปไม่ได้" };
  }
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date());
  const path = `${ctx.organizationId}/${ctx.storeId}/purchases/${month}/${randomUUID()}.jpg`;
  const service = await createSupabaseServiceClient();
  const upload = await service.storage.from(PURCHASE_EVIDENCE_BUCKET).upload(path, jpeg, { contentType: "image/jpeg", upsert: false });
  if (upload.error !== null) {
    await log({
      action: "uploadPurchaseImage",
      ok: false,
      message: `อัปโหลดรูปบิลไม่สำเร็จ: ${upload.error.message}`,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
    });
    return { error: "อัปโหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง" };
  }
  const registered = await registerPurchaseImage(ctx.storeId, path, jpeg.length, "manual");
  if (registered.error !== null) {
    // ลงทะเบียนไม่สำเร็จ = ไม่มีแถวอ้างถึง → ลบไฟล์ลอยทิ้ง (ยังไม่เคยเป็นหลักฐานของบิลใด)
    await service.storage.from(PURCHASE_EVIDENCE_BUCKET).remove([path]);
  }
  await log({
    action: "uploadPurchaseImage",
    ok: !registered.error,
    message: registered.error ? `ลงทะเบียนรูปบิลไม่สำเร็จ: ${registered.error}` : "อัปโหลดรูปบิลซื้อ",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { imageId: registered.data ?? null, bytes: jpeg.length },
  });
  if (registered.error !== null) return { error: registered.error };
  return { error: null, imageId: registered.data };
}

export async function postPurchaseBillAction(
  input: PurchaseBillInput,
): Promise<ActionResult & { negativeResets?: number; status?: "pending" | "posted" }> {
  const access = await getPurchaseSubmitAccess();
  if (!access.decision.allowed) return { error: access.decision.message };
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
      : `${result.data?.status === "pending" ? "ส่งบิลซื้อรออนุมัติ" : "บันทึกบิลซื้อ"} ${bill.total} บาท (${bill.lines.length} บรรทัด, ${bill.evidenceKind}, ${bill.paymentStatus === "paid" ? bill.paymentMethod : "ค้างจ่าย"})`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: {
      billId: result.data?.billId ?? null,
      status: result.data?.status ?? null,
      evidenceKind: bill.evidenceKind,
      images: bill.imageIds.length,
      supplierId: bill.supplierId,
      total: bill.total,
      lines: bill.lines.length,
      source: bill.source,
      negativeResets: result.data?.negativeResets ?? null,
    },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null, negativeResets: result.data?.negativeResets, status: result.data?.status };
}

export async function approvePurchaseBillAction(billId: string): Promise<ActionResult & { negativeResets?: number }> {
  const access = await editor();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  if (!UUID_RE.test(billId)) return { error: "ข้อมูลไม่ถูกต้อง" };
  const result = await approvePurchaseBill(billId);
  await log({
    action: "approvePurchaseBill",
    ok: !result.error,
    message: result.error ? `อนุมัติบิลซื้อไม่สำเร็จ: ${result.error}` : "อนุมัติบิลซื้อ — รับเข้าคลังแล้ว",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { billId, negativeResets: result.data?.negativeResets ?? null },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null, negativeResets: result.data?.negativeResets };
}

export async function rejectPurchaseBillAction(billId: string, reason: string): Promise<ActionResult & { outstanding?: number }> {
  const access = await editor();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  const cleaned = (reason ?? "").trim().slice(0, 300);
  if (!UUID_RE.test(billId)) return { error: "ข้อมูลไม่ถูกต้อง" };
  if (!cleaned) return { error: "ใส่เหตุผลที่ไม่อนุมัติ" };
  const result = await rejectPurchaseBill(billId, cleaned);
  await log({
    action: "rejectPurchaseBill",
    ok: !result.error,
    message: result.error ? `ไม่อนุมัติบิลซื้อไม่สำเร็จ: ${result.error}` : `ไม่อนุมัติบิลซื้อ (ต้องตามเงินคืน ${result.data} บาท)`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { billId, reason: cleaned },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null, outstanding: result.data ?? undefined };
}

export async function recoverPurchaseBillAction(billId: string, method: PayMethod): Promise<ActionResult> {
  const access = await editor();
  if ("error" in access) return { error: access.error ?? null };
  const { user, ctx } = access;
  if (!UUID_RE.test(billId) || (method !== "cash" && method !== "transfer")) return { error: "ข้อมูลไม่ถูกต้อง" };
  const result = await recoverPurchaseBill(billId, method);
  await log({
    action: "recoverPurchaseBill",
    ok: !result.error,
    message: result.error ? `รับเงินคืนบิลไม่อนุมัติไม่สำเร็จ: ${result.error}` : `รับเงินคืนบิลไม่อนุมัติ ${result.data} บาท (${method})`,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: { billId, method },
  });
  if (result.error) return { error: result.error };
  revalidateAll();
  return { error: null };
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

/**
 * A2: ให้ AI อ่านรูปบิลที่อัปโหลดแล้ว (รูปอยู่ในคลังหลักฐาน) → ร่างบิลให้คนตรวจก่อนบันทึก
 * ด่าน: ส่งบิลได้ + แพ็กเกจมี aiVision + AI เปิดอยู่ + จองโควตาก่อนเรียก (แบบ AI สแกนเมนู)
 * ล้ม/โควตาหมด/ไม่ใช่บิล → แจ้งตรง ๆ ให้กรอกเองต่อได้ (ห้ามสลับเครื่องมือเงียบ ๆ)
 */
export async function scanPurchaseBillAction(
  imageId: string,
): Promise<{ error: string | null; draft?: ScannedBillDraft }> {
  const access = await getPurchaseSubmitAccess();
  if (!access.decision.allowed) return { error: access.decision.message };
  const { user, ctx } = access;
  if (!UUID_RE.test(imageId)) return { error: "ข้อมูลรูปไม่ถูกต้อง" };
  const scanLog = (ok: boolean, message: string, context?: Record<string, unknown>) =>
    log({ action: "scanPurchaseBill", ok, message, organizationId: ctx.organizationId, storeId: ctx.storeId, actorUserId: user.id, context: { imageId, ...context } });

  const billing = await getOrganizationBillingState(ctx.organizationId);
  if (billing && !canUseFeature(billing, "aiVision")) {
    await scanLog(false, "อ่านบิลด้วย AI ไม่ได้: แพ็กเกจไม่มี aiVision");
    return { error: "แพ็กเกจปัจจุบันยังไม่รวม AI อ่านรูป — กรอกบิลเองได้ตามปกติ" };
  }
  if (!isAiEnabled()) {
    await scanLog(false, "อ่านบิลด้วย AI ไม่ได้: ระบบ AI ปิดอยู่");
    return { error: "ระบบ AI ยังไม่เปิดใช้ — กรอกบิลเองได้ตามปกติ" };
  }
  const image = await getVisibleEvidenceImage(ctx.storeId, imageId);
  if (!image) return { error: "ไม่พบรูปนี้ (หรือไม่ใช่รูปของคุณ) — อัปโหลดใหม่" };
  const bytes = await downloadEvidenceImage(image.storagePath);
  if (!bytes) {
    await scanLog(false, "อ่านบิลด้วย AI ไม่ได้: โหลดรูปจากคลังไม่สำเร็จ");
    return { error: "โหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง" };
  }
  const mime = sniffImageMime(bytes);
  if (!mime || bytes.byteLength > MAX_IMAGE_BYTES) return { error: "รูปนี้ให้ AI อ่านไม่ได้ — กรอกบิลเอง" };
  // รูปเสีย/เล็กผิดปกติ: ไม่เผาโควตา
  if (bytes.byteLength < MIN_IMAGE_BYTES) return { error: "รูปเล็กหรือไม่ชัดเกินไป — ถ่ายบิลให้เต็มกรอบแล้วลองใหม่" };

  const requestId = randomUUID();
  const requestHash = createHash("sha256").update(requestId).digest("hex").slice(0, 16);
  const reserve = await reserveQuota({ organizationId: ctx.organizationId, requestId, feature: "aiVision", maxTokens: BILL_SCAN_MAX_OUTPUT_TOKENS });
  if (!reserve.granted) {
    await scanLog(false, "อ่านบิลด้วย AI ไม่ได้: โควตา AI หมด", { reason: reserve.reason ?? null });
    return { error: "โควตา AI หมด — เติมเงินที่ ตั้งค่า → เรียกเก็บเงิน หรือกรอกบิลเองได้ตามปกติ" };
  }
  const settle = (tokens: number, status: "ok" | "error" | "denied") =>
    settleUsage({ organizationId: ctx.organizationId, requestId, feature: "aiVision", model: AI_DEFAULT_MODEL, storeId: ctx.storeId, userId: user.id, tokens, status, requestHash });

  let scan;
  try {
    scan = await extractBillFromImage(Buffer.from(bytes).toString("base64"), mime, AI_DEFAULT_MODEL);
    await settle(BILL_SCAN_MAX_OUTPUT_TOKENS, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "error";
    // หมดเวลา: ปล่อยให้การจองหมดอายุเอง (แบบสแกนเมนู) · อื่น ๆ คืนโควตา
    if (message !== "ai_timeout") await settle(0, message === "ai_disabled" ? "denied" : "error");
    await scanLog(false, `อ่านบิลด้วย AI ล้มเหลว: ${message}`);
    return { error: message === "ai_timeout" ? "AI ใช้เวลานานเกินไป — ลองใหม่ หรือกรอกบิลเอง" : "AI อ่านบิลไม่สำเร็จ — กรอกบิลเองได้ตามปกติ" };
  }

  const context = await loadScanContext(ctx.storeId);
  if (context.error) {
    await scanLog(false, `อ่านบิลแล้วแต่โหลดข้อมูลจับคู่ไม่สำเร็จ: ${context.error}`);
    return { error: "โหลดข้อมูลวัตถุดิบไม่สำเร็จ ลองใหม่อีกครั้ง" };
  }
  const history = new Map<string, { ingredientId: string | null; categoryId: string | null }>();
  for (const l of context.lines) {
    const key = normalizeItemName(l.rawName);
    if (key && !history.has(key)) history.set(key, { ingredientId: l.ingredientId, categoryId: l.categoryId });
  }
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
  const draft = buildScannedDraft({
    imageId,
    scan,
    todayIso,
    history,
    ingredients: context.ingredients,
    categoryIds: context.categoryIds,
    suppliers: context.suppliers,
  });
  const matched = draft.lines.filter((l) => l.match.kind !== "none").length;
  await scanLog(true, draft.isBill ? `AI อ่านบิล ${draft.lines.length} บรรทัด (จับคู่ได้ ${matched})` : `AI อ่านแล้วไม่ใช่บิล: ${draft.notBillReason}`, {
    isBill: draft.isBill,
    lines: draft.lines.length,
    matched,
    totalMatches: draft.check.totalMatches,
    paymentHint: draft.paymentHint,
  });
  return { error: null, draft };
}
