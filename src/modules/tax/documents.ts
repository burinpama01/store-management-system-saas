/**
 * เอกสารขาย (ใบกำกับภาษีเต็มรูป/ใบลดหนี้) — ชนิดข้อมูล + สูตรตรวจ (pure, เทสต์ได้)
 * ตัวเลขจริงคำนวณใน RPC (issue_tax_invoice_from_order) — ฝั่ง TS ใช้แสดงตัวอย่างและเทสต์ให้ตรงกัน
 */
export type SalesDocumentType = "tax_invoice" | "receipt_tax_invoice" | "credit_note";
export type SalesDocumentStatus = "issued" | "cancelled";

export interface PartySnapshot {
  name: string;
  taxId: string | null;
  branchCode: string | null;
  address: string | null;
  partyType?: "company" | "individual";
}

export interface SellerSnapshot {
  legalName: string;
  taxId: string;
  branchCode: string;
  address: string;
}

export interface SalesDocumentLine {
  lineNo: number;
  description: string;
  quantity: number;
  unitLabel: string | null;
  unitPrice: number;
  amount: number;
}

export interface SalesDocument {
  id: string;
  docType: SalesDocumentType;
  docNo: string;
  issueDate: string;
  status: SalesDocumentStatus;
  orderId: string | null;
  orderNumber: string | null;
  orderPaidAt: string | null;
  refDocumentId: string | null;
  seller: SellerSnapshot;
  buyer: PartySnapshot;
  pricesIncludeVat: boolean;
  vatRate: number;
  grossAmount: number;
  discountAmount: number;
  totalAmount: number;
  vatBase: number;
  vatAmount: number;
  originalTotal: number | null;
  correctedTotal: number | null;
  reason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  lines?: SalesDocumentLine[];
}

export const SALES_DOCUMENT_TITLES: Record<SalesDocumentType, string> = {
  tax_invoice: "ใบกำกับภาษี",
  receipt_tax_invoice: "ใบเสร็จรับเงิน/ใบกำกับภาษี",
  credit_note: "ใบลดหนี้",
};

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** ถอด VAT จากยอดที่รวม VAT แล้ว — ต้องตรงกับ SQL: round(total * rate / (100 + rate), 2) */
export function splitVatInclusive(total: number, vatRate: number): { vatBase: number; vatAmount: number } {
  const t = round2(total);
  const vatAmount = round2((t * vatRate) / (100 + vatRate));
  return { vatBase: round2(t - vatAmount), vatAmount };
}

/** ส่วนลดที่แสดงบนเอกสาร = ผลรวมรายการ − ยอดชำระ (ไม่ติดลบ) */
export function documentDiscount(gross: number, total: number): number {
  return Math.max(round2(gross - total), 0);
}

/** ใบกำกับที่ "ผูกบิลอยู่" (บิล void/คืนเงินไม่ได้) = issued และยังไม่มีใบลดหนี้ issued */
export function isActiveInvoice(doc: Pick<SalesDocument, "docType" | "status" | "id">, all: Pick<SalesDocument, "docType" | "status" | "refDocumentId">[]): boolean {
  if (doc.status !== "issued" || doc.docType === "credit_note") return false;
  return !all.some((d) => d.docType === "credit_note" && d.status === "issued" && d.refDocumentId === doc.id);
}

/** ข้อความผิดพลาดจาก RPC → ภาษาไทย (ไม่ส่งข้อความ SQL ดิบขึ้นจอ) */
export function taxDocumentErrorMessage(raw: string | null | undefined): string {
  const m = raw ?? "";
  const map: [string, string][] = [
    ["not enabled for this store", "สาขานี้ยังไม่ได้เปิดใช้ใบกำกับภาษี (ตั้งค่า › ข้อมูลภาษี)"],
    ["enterprise plan", "ใบกำกับภาษีเต็มรูปมีในแพ็กเกจ Enterprise"],
    ["VAT registered first", "ต้องตั้งค่าข้อมูลภาษีว่าจด VAT แล้วก่อน"],
    ["not allowed to manage", "ไม่มีสิทธิ์ทำรายการนี้"],
    ["VAT-inclusive prices", "ร้านตั้งราคาแบบแยก VAT — ออกใบกำกับจากบิลขายได้เฉพาะราคารวม VAT"],
    ["order must be paid", "ออกใบกำกับได้เฉพาะบิลที่ชำระแล้ว"],
    ["order total must be positive", "ยอดบิลต้องมากกว่า 0"],
    ["order not found", "ไม่พบบิลนี้"],
    ["order has no items", "บิลนี้ไม่มีรายการสินค้า"],
    ["already has an issued tax invoice", "บิลนี้ออกใบกำกับภาษีไปแล้ว — ยกเลิกใบเดิมก่อนถ้าต้องออกใหม่"],
    ["buyer not found", "ไม่พบข้อมูลผู้ซื้อ"],
    ["buyer address is required", "กรุณาระบุที่อยู่ผู้ซื้อ"],
    ["company buyer requires tax id", "ผู้ซื้อที่เป็นนิติบุคคลต้องมีเลขประจำตัวผู้เสียภาษี"],
    ["credit note requires an issued tax invoice", "ออกใบลดหนี้ได้เฉพาะใบกำกับภาษีที่ยังใช้งานอยู่"],
    ["credit note requires a reason", "กรุณาระบุเหตุผลการลดหนี้"],
    ["already has a credit note", "ใบกำกับนี้มีใบลดหนี้แล้ว"],
    ["document already cancelled", "เอกสารนี้ถูกยกเลิกไปแล้ว"],
    ["cancellation requires a reason", "กรุณาระบุเหตุผลการยกเลิก"],
    ["cancel the related credit note first", "ต้องยกเลิกใบลดหนี้ที่อ้างถึงใบนี้ก่อน"],
    ["document not found", "ไม่พบเอกสารนี้"],
    ["do not match gross amount", "ยอดรายการในบิลไม่ตรงกับยอดรวม — ตรวจบิลก่อนออกใบกำกับ"],
    ["only owner/admin", "เปิด/ปิดได้เฉพาะเจ้าของหรือแอดมิน"],
  ];
  return map.find(([needle]) => m.includes(needle))?.[1] ?? "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง";
}
