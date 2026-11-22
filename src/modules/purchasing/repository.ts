/**
 * บิลซื้อ — Supabase queries (เฟส A1)
 * เขียนผ่าน RPC security definer เท่านั้น (ตรวจ manager + stockManagement + สวิตช์คลังใน DB อีกชั้น)
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { ExpenseCategory, PayMethod, PurchaseBill, PurchaseBillInput } from "./types";

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
    ["bill total does not match", "ยอดสุทธิไม่ตรงกับรายการ − ส่วนลด + VAT"],
    ["purchase_bills_supplier_no_unique_idx", "บิลเลขนี้ของผู้ขายรายนี้บันทึกไปแล้ว"],
    ["supplier not found", "ไม่พบผู้ขาย (หรือปิดใช้งานอยู่)"],
    ["ingredient not found", "ไม่พบวัตถุดิบในสาขานี้"],
    ["expense category not found", "ไม่พบหมวดค่าใช้จ่าย"],
    ["insufficient cash in drawer", "เงินสดในลิ้นชักไม่พอ — เลือกโอน หรือค้างจ่าย"],
    ["cash session is not open", "ยังไม่ได้เปิดรอบเงินสด — เปิดรอบก่อน หรือเลือกโอน/ค้างจ่าย"],
    ["bill already paid", "บิลนี้จ่ายแล้ว"],
    ["bill is voided", "บิลนี้ถูกยกเลิกแล้ว"],
    ["void requires a reason", "ใส่เหตุผลที่ยกเลิก"],
    ["bill not found", "ไม่พบบิลนี้"],
    ["less than other expenses", "ยอดสุทธิน้อยกว่าค่าใช้จ่ายอื่นในบิล"],
    ["invalid", "ข้อมูลบิลไม่ถูกต้อง"],
  ];
  for (const [needle, text] of map) if (message.includes(needle)) return text;
  return "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
export async function listPurchaseBills(storeId: string, limit = 100): Promise<Result<PurchaseBill[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("purchase_bills")
    .select(
      "id, supplier_id, supplier_name, bill_no, bill_date, is_tax_invoice, subtotal, discount, vat_amount, total, payment_status, payment_method, due_date, status, source, note, void_reason, posted_at, purchase_bill_lines(line_no, ingredient_id, expense_category_id, raw_name, qty, unit_label, unit_price, line_total)",
    )
    .eq("store_id", storeId)
    .order("bill_date", { ascending: false })
    .order("posted_at", { ascending: false })
    .limit(limit);
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return {
    data: (data ?? []).map((r: any) => ({
      id: r.id,
      supplierId: r.supplier_id ?? null,
      supplierName: r.supplier_name ?? null,
      billNo: r.bill_no ?? null,
      billDate: r.bill_date,
      isTaxInvoice: r.is_tax_invoice === true,
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
      voidReason: r.void_reason ?? null,
      postedAt: r.posted_at,
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
    })),
    error: null,
  };
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
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function postPurchaseBill(
  storeId: string,
  bill: PurchaseBillInput,
): Promise<Result<{ billId: string; negativeResets: number }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("purchase_bill_post", { p_store_id: storeId, p_bill: bill });
  if (error) return { data: null, error: purchaseErrorMessage(error.message) };
  return { data: { billId: data?.billId, negativeResets: num(data?.negativeResets) }, error: null };
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
