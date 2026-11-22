/** ตรวจ/ทำความสะอาดข้อมูลผู้ขาย (pure — เทสต์ได้) */
import { isValidBranchCode, isValidThaiTaxId, normalizeThaiTaxId } from "@/shared/utils/thai-tax-id";
import type { SupplierInput } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanText(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function validateSupplier(input: SupplierInput): { value: SupplierInput } | { error: string } {
  const name = (input.name ?? "").trim();
  if (!name || name.length > 120) return { error: "ชื่อผู้ขายต้องมี 1–120 ตัวอักษร" };
  if (input.id && !UUID_RE.test(input.id)) return { error: "ข้อมูลผู้ขายไม่ถูกต้อง" };
  const taxIdRaw = cleanText(input.taxId, 20);
  const taxId = taxIdRaw ? normalizeThaiTaxId(taxIdRaw) : null;
  if (taxId && !isValidThaiTaxId(taxId)) return { error: "เลขประจำตัวผู้เสียภาษีไม่ถูกต้อง (13 หลัก)" };
  const branchCode = cleanText(input.branchCode, 5);
  if (branchCode && !isValidBranchCode(branchCode)) return { error: "เลขสาขาต้องเป็นตัวเลข 5 หลัก (สำนักงานใหญ่ = 00000)" };
  if (!Number.isInteger(input.leadDays) || input.leadDays < 0 || input.leadDays > 60) return { error: "วันรอของต้องเป็น 0–60 วัน" };
  if (!Number.isInteger(input.paymentTermsDays) || input.paymentTermsDays < 0 || input.paymentTermsDays > 180) {
    return { error: "เครดิตเทอมต้องเป็น 0–180 วัน" };
  }
  let consignment: SupplierInput["consignment"] = null;
  if (input.consignment) {
    const { payoutMethod, settleCycle } = input.consignment;
    if (payoutMethod !== "cash" && payoutMethod !== "transfer") return { error: "วิธีรับเงินไม่ถูกต้อง" };
    if (settleCycle !== "daily" && settleCycle !== "restock") return { error: "รอบเคลียร์เงินไม่ถูกต้อง" };
    consignment = { payoutMethod, settleCycle, payoutAccount: cleanText(input.consignment.payoutAccount, 120) };
  }
  return {
    value: {
      id: input.id ?? null,
      name,
      taxId,
      branchCode: taxId ? branchCode ?? "00000" : branchCode,
      contactName: cleanText(input.contactName, 120),
      phone: cleanText(input.phone, 40),
      lineId: cleanText(input.lineId, 80),
      address: cleanText(input.address, 500),
      note: cleanText(input.note, 500),
      leadDays: input.leadDays,
      paymentTermsDays: input.paymentTermsDays,
      isActive: input.isActive !== false,
      consignment,
    },
  };
}
