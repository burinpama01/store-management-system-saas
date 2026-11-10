import { EMPLOYMENT_TYPES, type EmploymentType, type PayType } from "./types";

/**
 * ข้อมูลพนักงานสำหรับสลิป (แผนสลิป v4 · P1) — validate แยกจาก server action เพื่อเทสต์ได้
 * กติกา: R8 (②③④ เฉพาะประจำ), R10/R25 (วันเริ่มอายุงาน แก้ย้อนหลังได้), R20 (เลขบัญชีเต็ม), R27 (วันออกงาน)
 */
export interface EmployeeIdentityInput {
  employeeCode?: string;
  fullName?: string;
  position?: string;
  employmentType: EmploymentType;
  permanentSince?: string;
  seniorityStartDate?: string;
  employmentEndDate?: string;
  bankName?: string;
  /** ไม่กรอก = ไม่เปลี่ยนเลขบัญชีเดิม (ฟอร์มไม่ส่งเลขเต็มกลับไปที่ browser) */
  bankAccountNo?: string;
  /** ติ๊ก "ลบเลขบัญชี" */
  clearBankAccount?: boolean;
  bankAccountName?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** ตัวอักษร/ตัวเลขทุกภาษา + - _ . / ไม่มีช่องว่าง */
const CODE_RE = /^[\p{L}\p{N}\-_./]{1,30}$/u;

function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function text(get: (key: string) => unknown, key: string, max: number): string | undefined {
  const v = String(get(key) ?? "").replace(/\s+/g, " ").trim();
  return v ? v.slice(0, max) : undefined;
}

/** ค่าเริ่มต้นประเภทการจ้างตามวิธีคิดเงิน (ใช้ตอนยังไม่เคยตั้ง) */
export function defaultEmploymentType(payType: PayType): EmploymentType {
  return payType === "monthly" ? "permanent" : "daily";
}

export function parseEmployeeIdentity(
  get: (key: string) => unknown,
  opts: { today: string },
): { value: EmployeeIdentityInput; error: null } | { value: null; error: string } {
  const employeeCode = text(get, "employeeCode", 60);
  if (employeeCode && !CODE_RE.test(employeeCode)) {
    return { value: null, error: "รหัสพนักงานใช้ได้แค่ตัวอักษร ตัวเลข - _ . / ไม่เกิน 30 ตัว และห้ามมีช่องว่าง" };
  }

  const employmentType = String(get("employmentType") ?? "permanent") as EmploymentType;
  if (!EMPLOYMENT_TYPES.includes(employmentType)) return { value: null, error: "ประเภทการจ้างไม่ถูกต้อง" };

  const dates: Record<"permanentSince" | "seniorityStartDate" | "employmentEndDate", string | undefined> = {
    permanentSince: undefined,
    seniorityStartDate: undefined,
    employmentEndDate: undefined,
  };
  for (const key of Object.keys(dates) as (keyof typeof dates)[]) {
    const raw = String(get(key) ?? "").trim();
    if (!raw) continue;
    if (!isValidDate(raw)) return { value: null, error: "วันที่ไม่ถูกต้อง" };
    dates[key] = raw;
  }

  // เป็นประจำแต่ไม่กรอกวันที่ = ประจำตั้งแต่วันนี้; ไม่ใช่ประจำ = ไม่มีวันที่ประจำ
  const permanentSince = employmentType === "permanent" ? (dates.permanentSince ?? opts.today) : undefined;

  if (dates.seniorityStartDate && dates.seniorityStartDate > opts.today) {
    return { value: null, error: "วันเริ่มงานต้องไม่เกินวันนี้" };
  }
  if (dates.employmentEndDate && dates.seniorityStartDate && dates.employmentEndDate < dates.seniorityStartDate) {
    return { value: null, error: "วันออกงานต้องไม่ก่อนวันเริ่มงาน" };
  }

  const bankAccountRaw = String(get("bankAccountNo") ?? "").trim();
  let bankAccountNo: string | undefined;
  if (bankAccountRaw) {
    const digits = bankAccountRaw.replace(/[\s-]/g, "");
    if (!/^\d{6,20}$/.test(digits)) return { value: null, error: "เลขบัญชีต้องเป็นตัวเลข 6–20 หลัก" };
    bankAccountNo = digits;
  }

  return {
    error: null,
    value: {
      employeeCode,
      fullName: text(get, "fullName", 150),
      position: text(get, "position", 80),
      employmentType,
      permanentSince,
      seniorityStartDate: dates.seniorityStartDate,
      employmentEndDate: dates.employmentEndDate,
      bankName: text(get, "bankName", 80),
      bankAccountNo,
      clearBankAccount: !bankAccountNo && get("clearBankAccount") === "on",
      bankAccountName: text(get, "bankAccountName", 150),
    },
  };
}

/** แสดงเลขบัญชีแบบปิดหลัก: "1234567890" → "••7890" */
export function maskBankAccount(accountNo?: string | null): string {
  const digits = (accountNo ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return `••${digits.slice(-4)}`;
}

/** อายุงานเป็น "X ปี Y เดือน" ณ วันที่กำหนด (ไม่มีวันเริ่ม = ว่าง) */
export function seniorityLabel(startDate: string | undefined, asOf: string): string {
  if (!startDate || !isValidDate(startDate) || !isValidDate(asOf) || startDate > asOf) return "";
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ay, am, ad] = asOf.split("-").map(Number);
  let months = (ay - sy) * 12 + (am - sm);
  if (ad < sd) months -= 1;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0 && rest === 0) return "ไม่ถึง 1 เดือน";
  return [years ? `${years} ปี` : "", rest ? `${rest} เดือน` : ""].filter(Boolean).join(" ");
}

/**
 * ผู้ออกสลิป: ตั้งชื่อนิติบุคคลใน HR แล้ว = ใช้ชุด HR ทั้งชุด (ไม่ปนเลขภาษี/ที่อยู่ของใบเสร็จ
 * ซึ่งอาจเป็นคนละนิติบุคคล); ไม่ตั้ง = ใช้ข้อมูลจากตั้งค่าใบเสร็จ แล้วจึงชื่อร้าน
 */
export function resolvePayslipIssuer(
  hr: { payslipLegalName?: string; payslipAddress?: string; payslipTaxId?: string },
  receipt: { storeName?: string; address?: string; taxId?: string } | null | undefined,
  storeName: string,
): { name: string; address?: string; taxId?: string } {
  if (hr.payslipLegalName) {
    return { name: hr.payslipLegalName, address: hr.payslipAddress || undefined, taxId: hr.payslipTaxId || undefined };
  }
  return {
    name: receipt?.storeName || storeName,
    address: hr.payslipAddress || receipt?.address || undefined,
    taxId: hr.payslipTaxId || receipt?.taxId || undefined,
  };
}
