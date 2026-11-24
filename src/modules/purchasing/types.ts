/** บิลซื้อ (เฟส A1 + v5) — Plan/Purchasing and Ingredient Inventory Plan v4.html + v5.html */

export type PayMethod = "cash" | "transfer";

/** ชนิดหลักฐาน: ใบกำกับภาษี · ใบเสร็จ/บิลร้านค้า · บิลเงินสดเขียนมือ (ต้องมีรูป + ต้องอนุมัติ) */
export type EvidenceKind = "tax_invoice" | "receipt" | "handwritten";
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["tax_invoice", "receipt", "handwritten"];
export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  tax_invoice: "ใบกำกับภาษี",
  receipt: "ใบเสร็จ/บิลร้านค้า",
  handwritten: "บิลเงินสดเขียนมือ",
};

export type BillStatus = "pending" | "posted" | "rejected" | "voided";
export const BILL_STATUS_LABELS: Record<BillStatus, string> = {
  pending: "รออนุมัติ",
  posted: "อนุมัติแล้ว",
  rejected: "ไม่อนุมัติ",
  voided: "ยกเลิก",
};

export const MAX_BILL_IMAGES = 10;

export interface PurchaseLineInput {
  ingredientId: string | null;
  expenseCategoryId: string | null;
  rawName: string;
  qty: number;
  unitLabel: string | null;
  unitPrice: number;
  lineTotal: number;
}

export interface PurchaseBillInput {
  supplierId: string | null;
  supplierName: string | null;
  billNo: string | null;
  billDate: string;
  evidenceKind: EvidenceKind;
  discount: number;
  vatAmount: number;
  total: number;
  paymentStatus: "paid" | "unpaid";
  paymentMethod: PayMethod | null;
  dueDate: string | null;
  note: string | null;
  source: "manual" | "ai";
  imageIds: string[];
  lines: PurchaseLineInput[];
}

export interface PurchaseBillLine {
  lineNo: number;
  ingredientId: string | null;
  expenseCategoryId: string | null;
  rawName: string;
  qty: number;
  unitLabel: string | null;
  unitPrice: number;
  lineTotal: number;
}

export interface PurchaseBillImage {
  id: string;
  storagePath: string;
  url: string | null; // ลิงก์ชั่วคราว (signed URL) — null ถ้าสร้างไม่สำเร็จ
}

export interface PurchaseBill {
  id: string;
  supplierId: string | null;
  supplierName: string | null;
  billNo: string | null;
  billDate: string;
  evidenceKind: EvidenceKind;
  subtotal: number;
  discount: number;
  vatAmount: number;
  total: number;
  paymentStatus: "paid" | "unpaid";
  paymentMethod: PayMethod | null;
  dueDate: string | null;
  status: BillStatus;
  source: "manual" | "ai";
  note: string | null;
  postedBy: string | null;
  postedByName: string | null;
  approvedBy: string | null;
  rejectReason: string | null;
  voidReason: string | null;
  postedAt: string;
  paidAmount: number; // ยอดรายจ่ายที่ลงไว้ (kind payment)
  recoveredAmount: number;
  lines: PurchaseBillLine[];
  images: PurchaseBillImage[];
}

export interface ExpenseCategory {
  id: string;
  name: string;
}

/** แถวคลังรูปหลักฐาน (หน้าส่งออก) */
export interface EvidenceImageRow {
  id: string;
  billId: string | null;
  storagePath: string;
  createdAt: string;
  url: string | null;
}
