/** เอกสารภาษี (เฟส B) — Plan/Tax Documents and Accounting Pack Plan v1.html */

export const DOCUMENT_TYPES = [
  "tax_invoice",
  "receipt_tax_invoice",
  "credit_note",
  "debit_note",
  "quotation",
  "invoice",
  "receipt",
  "receipt_substitute",
  "payment_voucher",
  "wht_certificate",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  tax_invoice: "ใบกำกับภาษี",
  receipt_tax_invoice: "ใบเสร็จรับเงิน/ใบกำกับภาษี",
  credit_note: "ใบลดหนี้",
  debit_note: "ใบเพิ่มหนี้",
  quotation: "ใบเสนอราคา",
  invoice: "ใบแจ้งหนี้",
  receipt: "ใบเสร็จรับเงิน",
  receipt_substitute: "ใบรับรองแทนใบเสร็จรับเงิน",
  payment_voucher: "ใบสำคัญจ่าย",
  wht_certificate: "หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ)",
};

/** ต้องตรงกับ public.document_default_prefix() ใน migration 20261215120000 */
export const DOCUMENT_PREFIX: Record<DocumentType, string> = {
  tax_invoice: "TIV",
  receipt_tax_invoice: "RTV",
  credit_note: "CN",
  debit_note: "DN",
  quotation: "QT",
  invoice: "IV",
  receipt: "RC",
  receipt_substitute: "RS",
  payment_voucher: "PV",
  wht_certificate: "WHT",
};

export interface StoreTaxProfile {
  storeId: string;
  legalName: string;
  taxId: string;
  branchCode: string;
  address: string;
  vatRegistered: boolean;
  vatRegisteredAt: string | null;
  posApprovalNo: string | null;
  pricesIncludeVat: boolean;
  vatRate: number;
  updatedAt: string;
}

export interface StoreTaxProfileInput {
  legalName: string;
  taxId: string;
  branchCode: string;
  address: string;
  vatRegistered: boolean;
  vatRegisteredAt: string | null;
  posApprovalNo: string | null;
  pricesIncludeVat: boolean;
  vatRate: number;
}

export interface TaxParty {
  id: string;
  partyType: "company" | "individual";
  name: string;
  taxId: string | null;
  branchCode: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  customerId: string | null;
  isActive: boolean;
}

export interface TaxPartyInput {
  id?: string | null;
  partyType: "company" | "individual";
  name: string;
  taxId: string | null;
  branchCode: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
  customerId: string | null;
  isActive: boolean;
}

export interface DocumentSequence {
  docType: DocumentType;
  period: string;
  prefix: string;
  lastIssuedNo: number;
}
