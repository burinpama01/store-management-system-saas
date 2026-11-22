/** ตรวจ/คำนวณบิลซื้อฝั่งแอป (pure — เทสต์ได้) · RPC ตรวจซ้ำทุกข้อ */
import type { PurchaseBillInput } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const round2 = (v: number) => Math.round(v * 100) / 100;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clean = (v: string | null | undefined, max: number) => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
};

export const MAX_BILL_LINES = 200;

/** ยอดสุทธิ = Σ ยอดบรรทัด − ส่วนลด + VAT (ตรงกับ SQL) */
export function billTotals(lines: Array<{ lineTotal: number }>, discount: number, vatAmount: number) {
  const subtotal = round2(lines.reduce((s, l) => s + round2(l.lineTotal || 0), 0));
  return { subtotal, total: round2(subtotal - (discount || 0) + (vatAmount || 0)) };
}

/** ยอดหลังรับของ: ติดลบ = นับใหม่ตามที่ซื้อ (ไม่ถมยอดติดลบ) · ใช้แสดงในฟอร์มให้ตรงกับ SQL */
export function onHandAfterReceive(onHand: number | null, usageQtyIn: number): { after: number; resetQty: number } {
  const base = onHand ?? 0;
  if (base < 0) return { after: usageQtyIn, resetQty: -base };
  return { after: base + usageQtyIn, resetQty: 0 };
}

export function validateBill(input: PurchaseBillInput): { value: PurchaseBillInput } | { error: string } {
  if (input.supplierId !== null && !isUuid(input.supplierId)) return { error: "ข้อมูลผู้ขายไม่ถูกต้อง" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.billDate ?? "")) return { error: "ใส่วันที่ในบิล" };
  if (!finite(input.discount) || input.discount < 0) return { error: "ส่วนลดไม่ถูกต้อง" };
  if (!finite(input.vatAmount) || input.vatAmount < 0) return { error: "VAT ไม่ถูกต้อง" };
  if (input.paymentStatus !== "paid" && input.paymentStatus !== "unpaid") return { error: "เลือกจ่ายแล้วหรือค้างจ่าย" };
  if (input.paymentStatus === "paid" && input.paymentMethod !== "cash" && input.paymentMethod !== "transfer") {
    return { error: "เลือกจ่ายเงินสดหรือโอน" };
  }
  if (input.dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) return { error: "วันครบกำหนดไม่ถูกต้อง" };
  const lines = (Array.isArray(input.lines) ? input.lines : []).filter((l) => l && (l.ingredientId || l.expenseCategoryId || l.rawName?.trim()));
  if (lines.length === 0) return { error: "ใส่รายการอย่างน้อย 1 บรรทัด" };
  if (lines.length > MAX_BILL_LINES) return { error: `บิลหนึ่งใส่ได้ไม่เกิน ${MAX_BILL_LINES} บรรทัด` };
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    const isIng = isUuid(l.ingredientId);
    const isExp = isUuid(l.expenseCategoryId);
    if (isIng === isExp) return { error: `บรรทัด ${n}: เลือกวัตถุดิบ หรือหมวดค่าใช้จ่าย อย่างใดอย่างหนึ่ง` };
    if (!finite(l.qty) || l.qty <= 0 || l.qty > 9_999_999) return { error: `บรรทัด ${n}: จำนวนต้องมากกว่า 0` };
    if (!finite(l.unitPrice) || l.unitPrice < 0) return { error: `บรรทัด ${n}: ราคาไม่ถูกต้อง` };
    if (!finite(l.lineTotal) || l.lineTotal < 0) return { error: `บรรทัด ${n}: ยอดรวมไม่ถูกต้อง` };
  }
  const { total } = billTotals(lines, input.discount, input.vatAmount);
  if (!finite(input.total) || round2(input.total) !== total) return { error: "ยอดสุทธิไม่ตรงกับรายการ − ส่วนลด + VAT" };
  return {
    value: {
      ...input,
      supplierName: input.supplierId ? null : clean(input.supplierName, 120),
      billNo: clean(input.billNo, 60),
      note: clean(input.note, 300),
      paymentMethod: input.paymentStatus === "paid" ? input.paymentMethod : null,
      dueDate: input.paymentStatus === "unpaid" ? input.dueDate : null,
      total,
      discount: round2(input.discount),
      vatAmount: round2(input.vatAmount),
      lines: lines.map((l) => ({
        ingredientId: isUuid(l.ingredientId) ? l.ingredientId : null,
        expenseCategoryId: isUuid(l.ingredientId) ? null : l.expenseCategoryId,
        rawName: (l.rawName ?? "").trim().slice(0, 200) || "-",
        qty: l.qty,
        unitLabel: clean(l.unitLabel, 30),
        unitPrice: l.unitPrice,
        lineTotal: round2(l.lineTotal),
      })),
    },
  };
}
