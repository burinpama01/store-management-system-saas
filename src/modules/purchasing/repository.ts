/**
 * บิลซื้อ — Supabase queries (เฟส A1 + v5 อนุมัติ/คลังรูป)
 * เขียนผ่าน RPC security definer เท่านั้น (ตรวจสิทธิ์ + stockManagement + สวิตช์คลังใน DB อีกชั้น)
 * รูปหลักฐานอยู่ใน bucket ส่วนตัว purchase-evidence — อ่านด้วย signed URL จาก service client หลังผ่านด่านแล้วเท่านั้น
 */
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type {
  EvidenceImageRow,
  ExpenseCategory,
  PayMethod,
  PurchaseBill,
  PurchaseBillImage,
  PurchaseBillInput,
} from "./types";

export const PURCHASE_EVIDENCE_BUCKET = "purchase-evidence";
const SIGNED_URL_SECONDS = 60 * 60;

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;
type Result<T> = { data: T; error: null } | { data: null; error: string };
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

export function purchaseErrorMessage(raw: string | undefined | null): string {
  const message = raw ?? "";
  const map: Array<[string, string]> = [
    ["not enabled for this store", "สาขานี้ยังไม่ได้เปิดคลังวัตถุดิบ"],
    ["manager role", "ต้องเป็นผู้จัดการขึ้นไปและแพ็กเกจมีระบบสต็อก"],
    ["store membership", "ต้องเป็นพนักงานของสาขานี้และแพ็กเกจมีระบบสต็อก"],
    ["bill total does not match", "ยอดสุทธิไม่ตรงกับรายการ − ส่วนลด + VAT"],
    ["purchase_bills_supplier_no_unique_idx", "บิลเลขนี้ของผู้ขายรายนี้บันทึกไปแล้ว"],
    ["supplier not found", "ไม่พบผู้ขาย (หรือปิดใช้งานอยู่)"],
    ["ingredient not found", "ไม่พบวัตถุดิบในสาขานี้"],
    ["expense category not found", "ไม่พบหมวดค่าใช้จ่าย"],
    ["insufficient cash in drawer", "เงินสดในลิ้นชักไม่พอ — เลือกโอน หรือค้างจ่าย"],
    ["cash session is not open", "ยังไม่ได้เปิดรอบเงินสด — เปิดรอบก่อน หรือเลือกโอน/ค้างจ่าย (คืนเงินสดต้องเปิดรอบอยู่)"],
    ["handwritten bill requires a photo", "บิลเขียนมือต้องแนบรูปบิลอย่างน้อย 1 รูป"],
    ["bill images not found", "รูปที่แนบใช้ไม่ได้ (ผูกกับบิลอื่นแล้ว หรือไม่ใช่รูปของคุณ) — อัปโหลดใหม่"],
    ["invalid image path", "ที่เก็บรูปไม่ถูกต้อง"],
    ["cannot approve own bill", "อนุมัติบิลที่ตัวเองส่งไม่ได้ — ให้ผู้จัดการคนอื่นหรือเจ้าของร้านอนุมัติ"],
    ["bill is not pending", "บิลนี้ไม่ได้รออนุมัติแล้ว"],
    ["bill is not rejected", "บิลนี้ไม่ได้อยู่ในสถานะไม่อนุมัติ"],
    ["nothing to recover", "บิลนี้รับเงินคืนครบแล้ว"],
    ["reject requires a reason", "ใส่เหตุผลที่ไม่อนุมัติ"],
    ["bill already paid", "บิลนี้จ่ายแล้ว"],
    ["bill is voided", "บิลนี้ถูกยกเลิกแล้ว"],
    ["bill is not posted", "บิลนี้ยังไม่อนุมัติ หรือไม่อยู่ในสถานะที่ทำรายการนี้ได้"],
    ["void requires a reason", "ใส่เหตุผลที่ยกเลิก"],
    ["bill not found", "ไม่พบบิลนี้"],
    ["less than other expenses", "ยอดสุทธิน้อยกว่าค่าใช้จ่ายอื่นในบิล"],
    ["invalid", "ข้อมูลบิลไม่ถูกต้อง"],
  ];
  for (const [needle, text] of map) if (message.includes(needle)) return text;
  return "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
}

/** ลิงก์ชั่วคราวของรูป (service client) — เรียกหลังผ่านด่านสิทธิ์แล้วเท่านั้น */
export async function signEvidenceUrls(paths: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(paths.filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const service = await createSupabaseServiceClient();
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data } = await service.storage.from(PURCHASE_EVIDENCE_BUCKET).createSignedUrls(chunk, SIGNED_URL_SECONDS);
    for (const row of data ?? []) if (row.path && row.signedUrl) out.set(row.path, row.signedUrl);
  }
  return out;
}

/** ชื่อผู้ส่งบิล (ชื่อในบัญชี หรืออีเมล) — ดึงเฉพาะคนที่ต้องแสดง */
async function userLabels(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))].slice(0, 50);
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const service = await createSupabaseServiceClient();
  const results = await Promise.all(unique.map((id) => service.auth.admin.getUserById(id).catch(() => null)));
  for (const r of results) {
    const u = r?.data?.user;
    if (!u) continue;
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    const name = typeof meta.full_name === "string" && meta.full_name.trim() ? meta.full_name.trim() : null;
    out.set(u.id, name ?? u.email ?? "พนักงาน");
  }
  return out;
}

const BILL_SELECT =
  "id, supplier_id, supplier_name, bill_no, bill_date, evidence_kind, subtotal, discount, vat_amount, total, payment_status, payment_method, due_date, status, source, note, posted_by, approved_by, reject_reason, recovered_amount, void_reason, posted_at, purchase_bill_lines(line_no, ingredient_id, expense_category_id, raw_name, qty, unit_label, unit_price, line_total), purchase_bill_images(id, storage_path)";

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
async function mapBills(rows: any[], paymentsByBill: Map<string, number>, withNames: boolean): Promise<PurchaseBill[]> {
  const paths = rows.flatMap((r) => (r.purchase_bill_images ?? []).map((i: any) => i.storage_path as string));
  const [urls, names] = await Promise.all([
    signEvidenceUrls(paths),
    withNames ? userLabels(rows.map((r) => r.posted_by)) : Promise.resolve(new Map<string, string>()),
  ]);
  return rows.map((r) => ({
    id: r.id,
    supplierId: r.supplier_id ?? null,
    supplierName: r.supplier_name ?? null,
    billNo: r.bill_no ?? null,
    billDate: r.bill_date,
    evidenceKind: r.evidence_kind,
    subtotal: num(r.subtotal),
    discount: num(r.discount),
    vatAmount: num(r.vat_amount),
    total: num(r.total),
    paymentStatus: r.payment_status,
    paymentMethod: r.payment_method ?? null,
    dueDate: r.due_date ?? null,
    status: r.status,
    source: r.source,
    note: r.note ?? null,
    postedBy: r.posted_by ?? null,
    postedByName: r.posted_by ? names.get(r.posted_by) ?? null : null,
    approvedBy: r.approved_by ?? null,
    rejectReason: r.reject_reason ?? null,
    voidReason: r.void_reason ?? null,
    postedAt: r.posted_at,
    paidAmount: paymentsByBill.get(r.id) ?? 0,
    recoveredAmount: num(r.recovered_amount),
    lines: [...(r.purchase_bill_lines ?? [])]
      .sort((a: any, b: any) => num(a.line_no) - num(b.line_no))
      .map((l: any) => ({
        lineNo: num(l.line_no),
        ingredientId: l.ingredient_id ?? null,
        expenseCategoryId: l.expense_category_id ?? null,
        rawName: l.raw_name,
        qty: num(l.qty),
        unitLabel: l.unit_label ?? null,
        unitPrice: num(l.unit_price),
        lineTotal: num(l.line_total),
      })),
    images: (r.purchase_bill_images ?? []).map(
      (i: any): PurchaseBillImage => ({ id: i.id, storagePath: i.storage_path, url: urls.get(i.storage_path) ?? null }),
    ),
  }));
}

/** ทุกบิลของสาขา (ผู้จัดการ) — RLS กรองให้อีกชั้น */
export async function listPurchaseBills(storeId: string, limit = 100): Promise<Result<PurchaseBill[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("purchase_bills")
    .select(BILL_SELECT)
    .eq("store_id", storeId)
    .order("bill_date", { ascending: false })
    .order("posted_at", { ascending: false })
    .limit(limit);
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  const rows = data ?? [];
  const paid = new Map<string, number>();
  const ids = rows.map((r: any) => r.id);
  if (ids.length > 0) {
    const { data: pays } = await db.from("purchase_bill_payments").select("bill_id, amount").eq("kind", "payment").in("bill_id", ids);
    for (const p of pays ?? []) paid.set(p.bill_id, (paid.get(p.bill_id) ?? 0) + num(p.amount));
  }
  const needNames = rows.some((r: any) => r.status === "pending" || r.status === "rejected");
  return { data: await mapBills(rows, paid, needNames), error: null };
}

/** บิลที่ผู้ใช้คนนี้ส่งเอง (หน้าพนักงาน) */
export async function listMyPurchaseBills(storeId: string, userId: string, limit = 30): Promise<Result<PurchaseBill[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("purchase_bills")
    .select(BILL_SELECT)
    .eq("store_id", storeId)
    .eq("posted_by", userId)
    .order("posted_at", { ascending: false })
    .limit(limit);
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: await mapBills(data ?? [], new Map(), false), error: null };
}

export async function countPendingBills(storeId: string): Promise<number> {
  const db: LooseClient = await createSupabaseServerClient();
  const { count } = await db
    .from("purchase_bills")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("status", "pending");
  return num(count);
}

export async function listExpenseCategories(storeId: string): Promise<Result<ExpenseCategory[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("accounting_categories")
    .select("id, name")
    .eq("store_id", storeId)
    .eq("type", "expense")
    .order("sort_order")
    .limit(200);
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: (data ?? []).map((r: any) => ({ id: r.id, name: r.name })), error: null };
}

/**
 * รายการตัวเลือกสำหรับหน้าพนักงาน (วัตถุดิบ/หมวดค่าใช้จ่าย) — พนักงานอ่านตารางเหล่านี้ผ่าน RLS ไม่ได้
 * จึงอ่านด้วย service client หลังผ่านด่าน getPurchaseSubmitAccess แล้ว และคืนเฉพาะชื่อ/หน่วย
 */
export async function listSubmitOptions(storeId: string): Promise<
  Result<{ ingredients: Array<{ id: string; name: string; purchaseUnit: string }>; categories: ExpenseCategory[] }>
> {
  const service: LooseClient = await createSupabaseServiceClient();
  const [ing, cat] = await Promise.all([
    service.from("ingredients").select("id, name, purchase_unit").eq("store_id", storeId).eq("is_active", true).order("name").limit(500),
    service.from("accounting_categories").select("id, name").eq("store_id", storeId).eq("type", "expense").order("sort_order").limit(200),
  ]);
  if (ing.error || cat.error) return { data: null, error: purchaseErrorMessage(ing.error?.message ?? cat.error?.message) };
  return {
    data: {
      ingredients: (ing.data ?? []).map((r: any) => ({ id: r.id, name: r.name, purchaseUnit: r.purchase_unit ?? "" })),
      categories: (cat.data ?? []).map((r: any) => ({ id: r.id, name: r.name })),
    },
    error: null,
  };
}

/** คลังรูปหลักฐานตามช่วงวันที่ (หน้าส่งออก) — รวมรูปที่ไม่ได้ผูกบิล */
export async function listEvidence(
  storeId: string,
  from: string,
  to: string,
): Promise<Result<{ bills: PurchaseBill[]; orphanImages: EvidenceImageRow[] }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("purchase_bills")
    .select(BILL_SELECT)
    .eq("store_id", storeId)
    .gte("bill_date", from)
    .lte("bill_date", to)
    .order("bill_date", { ascending: true })
    .limit(2000);
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  // รูปที่อัปโหลดแต่ไม่ได้ผูกบิล: ช่วงเวลาอัปโหลดตามวันที่ไทย
  const { data: orphans, error: orphanError } = await db
    .from("purchase_bill_images")
    .select("id, bill_id, storage_path, created_at")
    .eq("store_id", storeId)
    .is("bill_id", null)
    .gte("created_at", `${from}T00:00:00+07:00`)
    .lte("created_at", `${to}T23:59:59.999+07:00`)
    .order("created_at", { ascending: true })
    .limit(2000);
  if (orphanError) return { data: null, error: purchaseErrorMessage(orphanError.message) };
  const rows = data ?? [];
  const urls = await signEvidenceUrls((orphans ?? []).map((o: any) => o.storage_path));
  return {
    data: {
      bills: await mapBills(rows, new Map(), true),
      orphanImages: (orphans ?? []).map((o: any) => ({
        id: o.id,
        billId: null,
        storagePath: o.storage_path,
        createdAt: o.created_at,
        url: urls.get(o.storage_path) ?? null,
      })),
    },
    error: null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function registerPurchaseImage(storeId: string, path: string, bytes: number, source: "manual" | "ai"): Promise<Result<string>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_image_register", { p_store_id: storeId, p_path: path, p_bytes: bytes, p_source: source });
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: String(data), error: null };
}

export async function postPurchaseBill(
  storeId: string,
  bill: PurchaseBillInput,
): Promise<Result<{ billId: string; status: "pending" | "posted"; negativeResets: number }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_bill_post", { p_store_id: storeId, p_bill: bill });
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return {
    data: { billId: data?.billId, status: data?.status === "pending" ? "pending" : "posted", negativeResets: num(data?.negativeResets) },
    error: null,
  };
}

export async function approvePurchaseBill(billId: string): Promise<Result<{ negativeResets: number }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_bill_approve", { p_bill_id: billId });
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: { negativeResets: num(data?.negativeResets) }, error: null };
}

export async function rejectPurchaseBill(billId: string, reason: string): Promise<Result<number>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_bill_reject", { p_bill_id: billId, p_reason: reason });
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: num(data), error: null };
}

export async function recoverPurchaseBill(billId: string, method: PayMethod): Promise<Result<number>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_bill_recover", { p_bill_id: billId, p_method: method });
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: num(data), error: null };
}

export async function payPurchaseBill(billId: string, method: PayMethod): Promise<Result<number>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_bill_pay", { p_bill_id: billId, p_method: method });
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: num(data), error: null };
}

export async function voidPurchaseBill(billId: string, reason: string): Promise<Result<number>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_bill_void", { p_bill_id: billId, p_reason: reason });
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: num(data?.refunded), error: null };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
/** รูปหลักฐานที่ผู้ใช้คนนี้มีสิทธิ์เห็น (RLS: เจ้าของรูปหรือผู้จัดการ) ของสาขานี้ */
export async function getVisibleEvidenceImage(storeId: string, imageId: string): Promise<{ storagePath: string } | null> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data } = await db.from("purchase_bill_images").select("storage_path, store_id").eq("id", imageId).maybeSingle();
  if (!data || data.store_id !== storeId) return null;
  return { storagePath: data.storage_path };
}

export async function downloadEvidenceImage(storagePath: string): Promise<Uint8Array | null> {
  const service = await createSupabaseServiceClient();
  const { data, error } = await service.storage.from(PURCHASE_EVIDENCE_BUCKET).download(storagePath);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * ข้อมูลประกอบการจับคู่ผล AI (service client หลังผ่านด่านแล้ว · เฉพาะสาขานี้):
 * ชื่อบนบิลที่เคยยืนยัน → วัตถุดิบ/หมวด ล่าสุด, รายชื่อวัตถุดิบ/หมวด/ผู้ขายที่ใช้งาน
 */
export async function loadScanContext(storeId: string) {
  const service: LooseClient = await createSupabaseServiceClient();
  const [lines, ing, cat, sup] = await Promise.all([
    service
      .from("purchase_bill_lines")
      .select("raw_name, ingredient_id, expense_category_id, purchase_bills!inner(store_id, status, posted_at)")
      .eq("purchase_bills.store_id", storeId)
      .in("purchase_bills.status", ["pending", "posted"])
      .order("posted_at", { referencedTable: "purchase_bills", ascending: false })
      .limit(1000),
    service.from("ingredients").select("id, name").eq("store_id", storeId).eq("is_active", true).limit(1000),
    service.from("accounting_categories").select("id").eq("store_id", storeId).eq("type", "expense").limit(300),
    service.from("suppliers").select("id, name, tax_id, payment_terms_days").eq("store_id", storeId).eq("is_active", true).limit(500),
  ]);
  const rows = [...(lines.data ?? [])].sort((a: any, b: any) =>
    String(b.purchase_bills?.posted_at ?? "").localeCompare(String(a.purchase_bills?.posted_at ?? "")),
  );
  return {
    error: lines.error?.message ?? ing.error?.message ?? cat.error?.message ?? sup.error?.message ?? null,
    lines: rows.map((r: any) => ({ rawName: r.raw_name as string, ingredientId: r.ingredient_id ?? null, categoryId: r.expense_category_id ?? null })),
    ingredients: (ing.data ?? []).map((r: any) => ({ id: r.id as string, name: r.name as string })),
    categoryIds: new Set<string>((cat.data ?? []).map((r: any) => r.id as string)),
    suppliers: (sup.data ?? []).map((r: any) => ({
      id: r.id as string,
      name: r.name as string,
      taxId: (r.tax_id as string | null) ?? null,
      paymentTermsDays: num(r.payment_terms_days),
    })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
