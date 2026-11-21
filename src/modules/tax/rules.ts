/**
 * กติกาเอกสารภาษี (pure — เทสต์ได้)
 * ข้อกฎหมายอ้างอิงในแผน B หัวข้อ 2 — ต้องให้นักบัญชีตรวจก่อนเปิดออกเอกสารจริง (B1)
 */
import { isValidBranchCode, isValidThaiTaxId, normalizeThaiTaxId } from "@/shared/utils/thai-tax-id";
import { DOCUMENT_PREFIX, type DocumentType, type StoreTaxProfileInput, type TaxPartyInput } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function validateTaxProfile(input: StoreTaxProfileInput): { value: StoreTaxProfileInput } | { error: string } {
  const legalName = (input.legalName ?? "").trim();
  if (!legalName || legalName.length > 200) return { error: "ชื่อผู้ประกอบการ/นิติบุคคลต้องมี 1–200 ตัวอักษร" };
  const taxId = normalizeThaiTaxId(input.taxId ?? "");
  if (!isValidThaiTaxId(taxId)) return { error: "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (13 หลัก)" };
  const branchCode = (input.branchCode ?? "").trim() || "00000";
  if (!isValidBranchCode(branchCode)) return { error: "เลขสาขาต้องเป็นตัวเลข 5 หลัก (สำนักงานใหญ่ = 00000)" };
  const address = (input.address ?? "").trim();
  if (!address || address.length > 500) return { error: "กรุณาระบุที่อยู่ตามที่จดทะเบียน (ไม่เกิน 500 ตัวอักษร)" };
  const vatRegisteredAt = input.vatRegistered ? clean(input.vatRegisteredAt, 10) : null;
  // ช่อง date ของเบราว์เซอร์ส่งปี ค.ศ. — ปี พ.ศ. (เช่น 2569) จะกลายเป็นปี ค.ศ. 2569 ในฐานข้อมูล จึงปฏิเสธ
  if (vatRegisteredAt && (!DATE_RE.test(vatRegisteredAt) || Number(vatRegisteredAt.slice(0, 4)) < 1992 || Number(vatRegisteredAt.slice(0, 4)) > 2100)) {
    return { error: "วันที่จดทะเบียน VAT ไม่ถูกต้อง" };
  }
  const posApprovalNo = input.vatRegistered ? clean(input.posApprovalNo, 60) : null;
  if (!Number.isFinite(input.vatRate) || input.vatRate < 0 || input.vatRate > 30) return { error: "อัตรา VAT ไม่ถูกต้อง" };
  return {
    value: {
      legalName,
      taxId,
      branchCode,
      address,
      vatRegistered: input.vatRegistered === true,
      vatRegisteredAt,
      posApprovalNo,
      pricesIncludeVat: input.pricesIncludeVat !== false,
      vatRate: Math.round(input.vatRate * 100) / 100,
    },
  };
}

export function validateTaxParty(input: TaxPartyInput): { value: TaxPartyInput } | { error: string } {
  const name = (input.name ?? "").trim();
  if (!name || name.length > 200) return { error: "ชื่อผู้ซื้อต้องมี 1–200 ตัวอักษร" };
  if (input.id && !UUID_RE.test(input.id)) return { error: "ข้อมูลผู้ซื้อไม่ถูกต้อง" };
  if (input.partyType !== "company" && input.partyType !== "individual") return { error: "ประเภทผู้ซื้อไม่ถูกต้อง" };
  const rawTaxId = clean(input.taxId, 20);
  const taxId = rawTaxId ? normalizeThaiTaxId(rawTaxId) : null;
  if (taxId && !isValidThaiTaxId(taxId)) return { error: "เลขประจำตัวผู้เสียภาษีของผู้ซื้อไม่ถูกต้อง" };
  const branch = clean(input.branchCode, 5);
  if (branch && !isValidBranchCode(branch)) return { error: "เลขสาขาของผู้ซื้อต้องเป็นตัวเลข 5 หลัก" };
  const email = clean(input.email, 200);
  if (email && !EMAIL_RE.test(email)) return { error: "อีเมลไม่ถูกต้อง" };
  if (input.customerId && !UUID_RE.test(input.customerId)) return { error: "ข้อมูลสมาชิกไม่ถูกต้อง" };
  return {
    value: {
      id: input.id ?? null,
      partyType: input.partyType,
      name,
      taxId,
      // บริษัทที่มีเลขผู้เสียภาษีแต่ไม่ระบุสาขา = สำนักงานใหญ่
      branchCode: taxId && input.partyType === "company" ? branch ?? "00000" : branch,
      address: clean(input.address, 500),
      email,
      phone: clean(input.phone, 40),
      customerId: input.customerId ?? null,
      isActive: input.isActive !== false,
    },
  };
}

/** งวดเลขที่เอกสารตามเวลาไทย: "2569-11" (ต้องตรงกับ reserve_document_number) */
export function documentPeriod(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === "year")?.value) + 543;
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

/** รูปแบบเลขที่เอกสาร เช่น TIV6911-0001 (ต้องตรงกับ reserve_document_number) */
export function formatDocumentNumber(docType: DocumentType, period: string, no: number): string {
  const [year, month] = period.split("-");
  const seq = no > 9999 ? String(no) : String(no).padStart(4, "0");
  return `${DOCUMENT_PREFIX[docType]}${year.slice(2)}${month}-${seq}`;
}

/**
 * ร้านพิมพ์หัวใบเสร็จเป็น "ใบกำกับภาษีอย่างย่อ" ได้เมื่อจด VAT และได้รับอนุมัติเครื่อง POS (ภ.พ.06) แล้วเท่านั้น
 * ไม่ครบ = ใบเสร็จธรรมดา (ไม่อ้างว่าเป็นใบกำกับภาษี)
 */
export function canIssueAbbreviatedTaxInvoice(profile: { vatRegistered: boolean; posApprovalNo: string | null } | null): boolean {
  return Boolean(profile?.vatRegistered && profile.posApprovalNo && profile.posApprovalNo.trim());
}

/** ร้านออกใบกำกับภาษีเต็มรูปได้เมื่อจด VAT แล้ว */
export function canIssueFullTaxInvoice(profile: { vatRegistered: boolean } | null): boolean {
  return Boolean(profile?.vatRegistered);
}
