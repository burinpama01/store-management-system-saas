/**
 * เลขประจำตัวผู้เสียภาษี/บัตรประชาชนไทย 13 หลัก
 * หลักที่ 13 = (11 − (Σ หลักที่ i × (14 − i), i = 1..12) mod 11) mod 10
 */
export function normalizeThaiTaxId(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}

export function isValidThaiTaxId(raw: string): boolean {
  const id = normalizeThaiTaxId(raw);
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(id[i]) * (13 - i);
  const check = (11 - (sum % 11)) % 10;
  return check === Number(id[12]);
}

/** เลขสาขา 5 หลัก ("00000" = สำนักงานใหญ่) */
export function isValidBranchCode(raw: string): boolean {
  return /^\d{5}$/.test(raw.trim());
}

export function branchLabel(code: string | null | undefined): string {
  if (!code) return "";
  return code === "00000" ? "สำนักงานใหญ่" : `สาขาที่ ${code}`;
}
