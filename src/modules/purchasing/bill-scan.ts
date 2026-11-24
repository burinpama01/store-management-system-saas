/**
 * A2 — อ่านรูปบิลซื้อด้วย gpt-4o-mini (Plan v4 ข้อ 2 + v5)
 * - เครื่องมือเดียวกับ "AI สแกนเมนู" (ด่าน aiVision + โควตา AI เดิม) ไม่ใช้ iApp
 * - gpt ไม่มีค่ามั่นใจรายช่อง → ตรวจด้วยกฎยอดเงินแทน (±1 บาท) แล้วไฮไลต์จุดที่ไม่ตรง
 * - คนตรวจ/ยืนยันก่อนเสมอ แล้วบันทึกผ่าน purchase_bill_post เดิม (กติกาติดลบ/อนุมัติ/รายจ่ายเหมือนบิลมือ)
 * ส่วน pure (schema/ตรวจยอด/จับคู่) แยกจากการเรียก AI เพื่อเทสต์ได้
 */
import { z } from "zod";

export const SCAN_TOLERANCE = 1; // บาท
/** เพดาน output token ของการอ่านบิล — ใช้ทั้งเรียก AI และจอง/หักโควตา ให้ตรงกัน */
export const BILL_SCAN_MAX_OUTPUT_TOKENS = 2000;

const money = z.number().nonnegative().max(99_999_999).nullable();

export const BillScanLineSchema = z
  .object({
    name: z.string().min(1).max(200),
    qty: z.number().positive().max(9_999_999).nullable(),
    unit: z.string().max(30).nullable(),
    unitPrice: money,
    lineTotal: money,
  })
  .strict();

export const BillScanResultSchema = z
  .object({
    /** false = ไม่ใช่บิล/ใบเสร็จ (เช่น รายการซื้อเขียนมือที่ไม่มีราคา, รูปทั่วไป) */
    isBill: z.boolean(),
    /** เหตุผลสั้น ๆ เมื่อ isBill=false */
    notBillReason: z.string().max(200).nullable(),
    supplierName: z.string().max(120).nullable(),
    supplierTaxId: z.string().max(20).nullable(),
    billNo: z.string().max(60).nullable(),
    /** วันที่ตามที่พิมพ์บนบิล (เช่น 22/11/2569) — โค้ดแปลง พ.ศ./รูปแบบเอง ไม่ให้ AI แปลง */
    billDateText: z.string().max(40).nullable(),
    /** หัวเอกสารตามที่พิมพ์ (เช่น ใบส่งสินค้า/ใบแจ้งหนี้, ใบเสร็จรับเงิน) */
    documentTitle: z.string().max(80).nullable(),
    /** ยอด "รับเงิน" ที่พิมพ์บนบิล (0 = ยังไม่ได้รับเงิน/เงินเชื่อ) */
    amountReceived: money,
    /** มีช่องลูกหนี้/ลูกค้าเครดิตบนบิล */
    hasDebtorField: z.boolean(),
    isTaxInvoice: z.boolean(),
    handwritten: z.boolean(),
    /** credit = บิลเงินเชื่อ/ใบส่งของ/ใบแจ้งหนี้ (ยังไม่จ่าย) · cash = รับเงินแล้ว */
    paymentHint: z.enum(["cash", "credit", "unknown"]),
    lines: z.array(BillScanLineSchema).max(60),
    subtotal: money,
    discount: money,
    vatAmount: money,
    total: money,
  })
  .strict();

export type BillScanResult = z.infer<typeof BillScanResultSchema>;
export type BillScanLine = z.infer<typeof BillScanLineSchema>;

const round2 = (v: number) => Math.round(v * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) <= SCAN_TOLERANCE;

export interface ScanCheck {
  /** ดัชนีบรรทัดที่ จำนวน × ราคา ≠ รวมบรรทัด หรืออ่านตัวเลขไม่ครบ */
  lineIssues: number[];
  /** ข้อความเตือนระดับหัวบิล */
  warnings: string[];
  /** Σ บรรทัด − ส่วนลด + VAT ตรงกับยอดรวมบนบิล */
  totalMatches: boolean;
}

/** ตรวจยอดด้วยกฎแทนค่าความมั่นใจ */
export function checkScannedBill(scan: Pick<BillScanResult, "lines" | "subtotal" | "discount" | "vatAmount" | "total">): ScanCheck {
  const lineIssues: number[] = [];
  const warnings: string[] = [];
  scan.lines.forEach((l, i) => {
    if (l.qty === null || l.lineTotal === null) {
      lineIssues.push(i);
      return;
    }
    if (l.unitPrice !== null && !near(round2(l.qty * l.unitPrice), l.lineTotal)) lineIssues.push(i);
  });
  const sumLines = round2(scan.lines.reduce((s, l) => s + (l.lineTotal ?? 0), 0));
  if (scan.subtotal !== null && !near(sumLines, scan.subtotal)) {
    warnings.push(`รวมรายการ ${sumLines.toFixed(2)} ไม่ตรงกับยอดก่อน VAT บนบิล ${scan.subtotal.toFixed(2)}`);
  }
  const computed = round2(sumLines - (scan.discount ?? 0) + (scan.vatAmount ?? 0));
  let totalMatches = true;
  if (scan.total === null) {
    totalMatches = false;
    warnings.push("อ่านยอดรวมบนบิลไม่ได้ — ตรวจยอดเอง");
  } else if (!near(computed, scan.total)) {
    totalMatches = false;
    warnings.push(`คำนวณได้ ${computed.toFixed(2)} แต่ยอดรวมบนบิล ${scan.total.toFixed(2)} — ตรวจบรรทัดที่ไฮไลต์`);
  }
  if (lineIssues.length > 0) warnings.push(`${lineIssues.length} บรรทัดอ่านตัวเลขไม่ครบหรือ จำนวน × ราคา ไม่ตรงยอด`);
  return { lineIssues, warnings, totalMatches };
}

/**
 * แปลงวันที่ตามที่พิมพ์บนบิลเป็น YYYY-MM-DD (โค้ดทำเอง เพราะ AI แปลง พ.ศ. ผิดบ่อย)
 * รองรับ d/m/yyyy, d-m-yy, d.m.yyyy, yyyy-mm-dd · พ.ศ. (ปี > 2400 หรือ 2 หลัก ≥ 50) → ค.ศ.
 * อนาคต / เก่ากว่า 2 ปี / วันไม่มีจริง → null ให้คนกรอกเอง
 */
export function normalizeBillDate(raw: string | null, todayIso: string): string | null {
  if (!raw) return null;
  const text = raw.trim();
  let y: number, mo: number, d: number;
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const dmy = /(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2,4})/.exec(text);
  if (iso) {
    [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (dmy) {
    [d, mo, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    if (dmy[3].length === 2) y = y >= 50 ? 2500 + y : 2000 + y; // 69 = พ.ศ. 2569 · 25 = ค.ศ. 2025
  } else return null;
  if (y > 2400) y -= 543;
  return validIsoDate(y, mo, d, todayIso);
}

function validIsoDate(year: number, month: number, day: number, todayIso: string): string | null {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  // วันที่ในอนาคต หรือเก่ากว่า 2 ปี = น่าจะอ่านผิด → ให้คนกรอกเอง
  const today = new Date(`${todayIso}T00:00:00Z`).getTime();
  if (d.getTime() > today + 86_400_000 || d.getTime() < today - 730 * 86_400_000) return null;
  return iso;
}

export function normalizeTaxId(raw: string | null): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length === 13 ? digits : null;
}

/** ทำชื่อให้เทียบกันได้: ตัดช่องว่าง เครื่องหมาย ราคา @55 และตัวพิมพ์ */
export function normalizeItemName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/@\s*\d+(\.\d+)?/g, "")
    .replace(/[\s*().,\-_/\\'"#:+]+/g, "")
    .trim();
}

export interface MatchCandidate {
  id: string;
  name: string;
}

export type LineMatch =
  | { kind: "ingredient"; id: string; via: "history" | "name" }
  | { kind: "category"; id: string; via: "history" }
  | { kind: "none" };

/**
 * จับคู่บรรทัดกับวัตถุดิบ/หมวดค่าใช้จ่าย:
 * 1) ชื่อที่เคยยืนยันในบิลก่อน ๆ (raw_name → ingredient/category ล่าสุด) = alias ที่ระบบจำ
 * 2) ชื่อวัตถุดิบตรงกัน หรืออยู่ในชื่อบนบิล (เลือกชื่อที่ยาวสุด กันจับคำสั้นผิด)
 * 3) ไม่เจอ → ให้คนเลือก (ห้ามเดา)
 */
export function matchLine(
  rawName: string,
  history: Map<string, { ingredientId: string | null; categoryId: string | null }>,
  ingredients: MatchCandidate[],
  activeIngredientIds: Set<string>,
  activeCategoryIds: Set<string>,
): LineMatch {
  const key = normalizeItemName(rawName);
  if (!key) return { kind: "none" };
  const past = history.get(key);
  if (past?.ingredientId && activeIngredientIds.has(past.ingredientId)) return { kind: "ingredient", id: past.ingredientId, via: "history" };
  if (past?.categoryId && activeCategoryIds.has(past.categoryId)) return { kind: "category", id: past.categoryId, via: "history" };
  let best: { id: string; len: number } | null = null;
  for (const ing of ingredients) {
    const n = normalizeItemName(ing.name);
    if (n.length < 2) continue;
    if (key === n || key.includes(n) || (n.includes(key) && key.length >= 3)) {
      if (!best || n.length > best.len) best = { id: ing.id, len: n.length };
    }
  }
  return best ? { kind: "ingredient", id: best.id, via: "name" } : { kind: "none" };
}

/** จับคู่ผู้ขาย: เลขผู้เสียภาษีตรง → ชื่อตรง/อยู่ในกัน */
export function matchSupplier(
  scan: Pick<BillScanResult, "supplierName" | "supplierTaxId">,
  suppliers: Array<{ id: string; name: string; taxId: string | null }>,
): string | null {
  const tax = normalizeTaxId(scan.supplierTaxId);
  if (tax) {
    const byTax = suppliers.find((s) => s.taxId === tax);
    if (byTax) return byTax.id;
  }
  const key = normalizeItemName(scan.supplierName ?? "");
  if (key.length < 3) return null;
  const byName = suppliers.find((s) => {
    const n = normalizeItemName(s.name);
    return n.length >= 3 && (n === key || key.includes(n) || n.includes(key));
  });
  return byName?.id ?? null;
}

/** บิลเงินเชื่อไหม — ตัดสินจากข้อความบนบิล (โค้ด) ก่อนคำเดาของ AI */
export function decidePaymentHint(scan: Pick<BillScanResult, "documentTitle" | "amountReceived" | "hasDebtorField" | "paymentHint">): "cash" | "credit" | "unknown" {
  const title = (scan.documentTitle ?? "").replace(/\s+/g, "");
  if (/ใบส่ง|แจ้งหนี้|เงินเชื่อ|วางบิล|invoice/i.test(title) && !/ใบเสร็จรับเงิน/.test(title)) return "credit";
  if (scan.amountReceived === 0) return "credit";
  if (scan.hasDebtorField && scan.amountReceived === null) return "credit";
  if (/ใบเสร็จ|บิลเงินสด|receipt/i.test(title)) return "cash";
  return scan.paymentHint;
}

/** ผลที่ส่งกลับไปหน้าตรวจ (หลังจับคู่แล้ว) */
export interface ScannedBillDraft {
  imageId: string;
  isBill: boolean;
  notBillReason: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /** ชื่อผู้ขายสำหรับฟอร์มที่ไม่มีช่องเลือกผู้ขาย: ชื่อในทะเบียน (ถ้าจับคู่ได้) หรือชื่อที่ AI อ่าน */
  supplierLabel: string | null;
  billNo: string | null;
  billDate: string | null;
  evidenceKind: "tax_invoice" | "receipt" | "handwritten";
  paymentHint: "cash" | "credit" | "unknown";
  dueDate: string | null;
  discount: number;
  vatAmount: number;
  total: number | null;
  lines: Array<{
    rawName: string;
    qty: number | null;
    unit: string | null;
    unitPrice: number | null;
    lineTotal: number | null;
    match: LineMatch;
    issue: boolean;
  }>;
  check: ScanCheck;
}

/** ประกอบร่างบิลจากผล AI + ข้อมูลร้าน (pure) */
export function buildScannedDraft(input: {
  imageId: string;
  scan: BillScanResult;
  todayIso: string;
  history: Map<string, { ingredientId: string | null; categoryId: string | null }>;
  ingredients: MatchCandidate[];
  categoryIds: Set<string>;
  suppliers: Array<{ id: string; name: string; taxId: string | null; paymentTermsDays: number }>;
}): ScannedBillDraft {
  const { scan } = input;
  const check = checkScannedBill(scan);
  const ingIds = new Set(input.ingredients.map((i) => i.id));
  const supplierId = scan.isBill ? matchSupplier(scan, input.suppliers) : null;
  const billDate = normalizeBillDate(scan.billDateText, input.todayIso);
  const paymentHint = decidePaymentHint(scan);
  const terms = input.suppliers.find((s) => s.id === supplierId)?.paymentTermsDays ?? 0;
  let dueDate: string | null = null;
  if (paymentHint === "credit" && terms > 0) {
    const base = new Date(`${billDate ?? input.todayIso}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + terms);
    dueDate = base.toISOString().slice(0, 10);
  }
  return {
    imageId: input.imageId,
    isBill: scan.isBill && scan.lines.length > 0,
    notBillReason: scan.isBill && scan.lines.length > 0 ? null : (scan.notBillReason ?? "ไม่พบรายการซื้อที่มียอดเงินในรูปนี้"),
    supplierId,
    supplierName: supplierId ? null : (scan.supplierName?.trim().slice(0, 120) || null),
    supplierLabel: (input.suppliers.find((s) => s.id === supplierId)?.name ?? scan.supplierName?.trim() ?? "").slice(0, 120) || null,
    billNo: scan.billNo?.trim().slice(0, 60) || null,
    billDate,
    evidenceKind: scan.isTaxInvoice ? "tax_invoice" : scan.handwritten ? "handwritten" : "receipt",
    paymentHint,
    dueDate,
    discount: scan.discount ?? 0,
    vatAmount: scan.vatAmount ?? 0,
    total: scan.total,
    lines: scan.lines.map((l, i) => ({
      rawName: l.name.trim().slice(0, 200),
      qty: l.qty,
      unit: l.unit?.trim().slice(0, 30) || null,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal ?? (l.qty !== null && l.unitPrice !== null ? round2(l.qty * l.unitPrice) : null),
      match: matchLine(l.name, input.history, input.ingredients, ingIds, input.categoryIds),
      issue: check.lineIssues.includes(i),
    })),
    check,
  };
}
