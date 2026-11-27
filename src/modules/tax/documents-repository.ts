/**
 * เอกสารขาย — Supabase queries (client ของผู้ใช้ → RLS แคชเชียร์ขึ้นไป) · การออก/ยกเลิกผ่าน RPC เท่านั้น
 */
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { taxDocumentErrorMessage, type SalesDocument, type SalesDocumentLine } from "./documents";

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ missions/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

type Result<T> = { data: T; error: null } | { data: null; error: string };

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : num(v));

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
function mapDocument(row: any): SalesDocument {
  return {
    id: row.id,
    docType: row.doc_type,
    docNo: row.doc_no,
    issueDate: row.issue_date,
    status: row.status,
    orderId: row.order_id ?? null,
    orderNumber: row.order_number ?? null,
    orderPaidAt: row.order_paid_at ?? null,
    refDocumentId: row.ref_document_id ?? null,
    seller: row.seller_snapshot,
    buyer: row.buyer_snapshot,
    pricesIncludeVat: row.prices_include_vat === true,
    vatRate: num(row.vat_rate),
    grossAmount: num(row.gross_amount),
    discountAmount: num(row.discount_amount),
    totalAmount: num(row.total_amount),
    vatBase: num(row.vat_base),
    vatAmount: num(row.vat_amount),
    originalTotal: numOrNull(row.original_total),
    correctedTotal: numOrNull(row.corrected_total),
    reason: row.reason ?? null,
    cancelledAt: row.cancelled_at ?? null,
    cancelReason: row.cancel_reason ?? null,
    createdAt: row.created_at,
  };
}

export async function isTaxDocumentsEnabled(storeId: string): Promise<boolean> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db.from("stores").select("tax_documents_enabled").eq("id", storeId).maybeSingle();
  if (error || !data) return false;
  return data.tax_documents_enabled === true;
}

export async function setTaxDocumentsEnabled(storeId: string, enabled: boolean): Promise<Result<boolean>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("tax_documents_set_enabled", { p_store_id: storeId, p_enabled: enabled });
  if (error) return { data: null, error: taxDocumentErrorMessage(error.message) };
  return { data: data === true, error: null };
}

export async function listSalesDocuments(storeId: string, limit = 100): Promise<Result<SalesDocument[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("sales_documents")
    .select("*")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 300));
  if (error) return { data: null, error: taxDocumentErrorMessage(error.message) };
  return { data: (data ?? []).map(mapDocument), error: null };
}

export async function getSalesDocument(storeId: string, id: string): Promise<Result<SalesDocument | null>> {
  const db: LooseClient = await createSupabaseServerClient();
  const [docRes, linesRes] = await Promise.all([
    db.from("sales_documents").select("*").eq("id", id).eq("store_id", storeId).maybeSingle(),
    db.from("sales_document_lines").select("*").eq("document_id", id).order("line_no"),
  ]);
  const error = docRes.error ?? linesRes.error;
  if (error) return { data: null, error: taxDocumentErrorMessage(error.message) };
  if (!docRes.data) return { data: null, error: null };
  const lines: SalesDocumentLine[] = (linesRes.data ?? []).map((row: any) => ({
    lineNo: num(row.line_no),
    description: row.description,
    quantity: num(row.quantity),
    unitLabel: row.unit_label ?? null,
    unitPrice: num(row.unit_price),
    amount: num(row.amount),
  }));
  return { data: { ...mapDocument(docRes.data), lines }, error: null };
}

export interface OrderForInvoice {
  id: string;
  orderNumber: string;
  status: string;
  total: number;
  paidAt: string | null;
  createdAt: string;
  itemCount: number;
}

/** ค้นบิลด้วยเลขบิล (ตรงตัว) ในสาขาปัจจุบัน — RLS orders ของสมาชิกร้าน */
export async function findOrderByNumber(storeId: string, orderNumber: string): Promise<Result<OrderForInvoice | null>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("orders")
    .select("id, order_number, status, total, paid_at, created_at")
    .eq("store_id", storeId)
    .eq("order_number", orderNumber)
    .maybeSingle();
  if (error) return { data: null, error: "ค้นหาบิลไม่สำเร็จ" };
  if (!data) return { data: null, error: null };
  const { count } = await db.from("order_items").select("id", { count: "exact", head: true }).eq("order_id", data.id).eq("voided", false);
  return {
    data: {
      id: data.id,
      orderNumber: data.order_number,
      status: data.status,
      total: num(data.total),
      paidAt: data.paid_at ?? null,
      createdAt: data.created_at,
      itemCount: count ?? 0,
    },
    error: null,
  };
}

export async function issueTaxInvoiceFromOrder(orderId: string, partyId: string): Promise<Result<{ id: string; docNo: string }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("issue_tax_invoice_from_order", { p_order_id: orderId, p_party_id: partyId });
  if (error) return { data: null, error: taxDocumentErrorMessage(error.message) };
  const row = Array.isArray(data) ? data[0] : data;
  return { data: { id: row.id, docNo: row.doc_no }, error: null };
}

export async function issueFullCreditNote(documentId: string, reason: string): Promise<Result<{ id: string; docNo: string }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.rpc("issue_full_credit_note", { p_document_id: documentId, p_reason: reason });
  if (error) return { data: null, error: taxDocumentErrorMessage(error.message) };
  const row = Array.isArray(data) ? data[0] : data;
  return { data: { id: row.id, docNo: row.doc_no }, error: null };
}

export async function cancelSalesDocument(documentId: string, reason: string): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { error } = await db.rpc("cancel_sales_document", { p_document_id: documentId, p_reason: reason });
  if (error) return { data: null, error: taxDocumentErrorMessage(error.message) };
  return { data: true, error: null };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
