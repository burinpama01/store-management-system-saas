/** บิลซื้อ (เฟส A1) — Plan/Purchasing and Ingredient Inventory Plan v4.html */

export type PayMethod = "cash" | "transfer";

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
  isTaxInvoice: boolean;
  discount: number;
  vatAmount: number;
  total: number;
  paymentStatus: "paid" | "unpaid";
  paymentMethod: PayMethod | null;
  dueDate: string | null;
  note: string | null;
  source: "manual" | "ai";
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

export interface PurchaseBill {
  id: string;
  supplierId: string | null;
  supplierName: string | null;
  billNo: string | null;
  billDate: string;
  isTaxInvoice: boolean;
  subtotal: number;
  discount: number;
  vatAmount: number;
  total: number;
  paymentStatus: "paid" | "unpaid";
  paymentMethod: PayMethod | null;
  dueDate: string | null;
  status: "posted" | "voided";
  source: "manual" | "ai";
  note: string | null;
  voidReason: string | null;
  postedAt: string;
  lines: PurchaseBillLine[];
}

export interface ExpenseCategory {
  id: string;
  name: string;
}
