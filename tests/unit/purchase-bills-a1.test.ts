import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { purchaseErrorMessage } from "@/modules/purchasing/repository";
import { billTotals, onHandAfterReceive, validateBill } from "@/modules/purchasing/validate";
import { MOVEMENT_LABELS, MOVEMENT_TYPES } from "@/modules/inventory/types";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const sql = read("supabase/migrations/20261206120000_purchase_bills_a1.sql").toLowerCase().replace(/\s+/g, " ");

const ING = "11111111-1111-4111-8111-111111111111";
const CAT = "22222222-2222-4222-8222-222222222222";
const base = {
  supplierId: null,
  supplierName: " ศุภชัยบรรจุภัณฑ์ ",
  billNo: " N6911-01829 ",
  billDate: "2026-11-22",
  evidenceKind: "receipt" as const,
  imageIds: [] as string[],
  discount: 0,
  vatAmount: 0,
  total: 248,
  paymentStatus: "unpaid" as const,
  paymentMethod: null,
  dueDate: null,
  note: null,
  source: "manual" as const,
  lines: [
    { ingredientId: ING, expenseCategoryId: null, rawName: "นมโอ๊ต*ใหญ่", qty: 1, unitLabel: null, unitPrice: 55, lineTotal: 55 },
    { ingredientId: null, expenseCategoryId: CAT, rawName: "ฝาโดม98", qty: 2, unitLabel: null, unitPrice: 40, lineTotal: 80 },
    { ingredientId: null, expenseCategoryId: CAT, rawName: "หลอดงอ", qty: 2, unitLabel: null, unitPrice: 20, lineTotal: 40 },
    { ingredientId: ING, expenseCategoryId: null, rawName: "สปินซ์สตรอเบอรี่", qty: 1, unitLabel: null, unitPrice: 73, lineTotal: 73 },
  ],
};

describe("negative stock rule (v3/v4)", () => {
  it("receiving while negative counts only the new purchase", () => {
    expect(onHandAfterReceive(-3000, 5000)).toEqual({ after: 5000, resetQty: 3000 });
  });
  it("normal / zero / unset stock adds up", () => {
    expect(onHandAfterReceive(2000, 5000)).toEqual({ after: 7000, resetQty: 0 });
    expect(onHandAfterReceive(0, 5000)).toEqual({ after: 5000, resetQty: 0 });
    expect(onHandAfterReceive(null, 5000)).toEqual({ after: 5000, resetQty: 0 });
  });
  it("has a movement type + label", () => {
    expect(MOVEMENT_TYPES).toContain("negative_reset");
    expect(MOVEMENT_LABELS.negative_reset).toContain("ใช้เกินก่อนรับของ");
  });
});

describe("bill totals + validation (sample receipt 248.00)", () => {
  it("sums lines − discount + VAT", () => {
    expect(billTotals(base.lines, 0, 0)).toEqual({ subtotal: 248, total: 248 });
    expect(billTotals(base.lines, 8, 16.8)).toEqual({ subtotal: 248, total: 256.8 });
  });
  it("accepts the sample bill and trims fields", () => {
    const r = validateBill(base);
    expect("value" in r && r.value).toMatchObject({ supplierName: "ศุภชัยบรรจุภัณฑ์", billNo: "N6911-01829", total: 248, paymentMethod: null });
  });
  it("rejects a total that does not match", () => {
    expect(validateBill({ ...base, total: 250 })).toEqual({ error: "ยอดสุทธิไม่ตรงกับรายการ − ส่วนลด + VAT" });
  });
  it("each line is either an ingredient or an expense category", () => {
    const both = { ...base, lines: [{ ...base.lines[0], expenseCategoryId: CAT }] , total: 55 };
    expect(validateBill(both)).toHaveProperty("error");
    const none = { ...base, lines: [{ ...base.lines[0], ingredientId: null }], total: 55 };
    expect(validateBill(none)).toHaveProperty("error");
  });
  it("paid needs a method; unpaid drops the method", () => {
    expect(validateBill({ ...base, paymentStatus: "paid" })).toEqual({ error: "เลือกจ่ายเงินสดหรือโอน" });
    const r = validateBill({ ...base, paymentStatus: "unpaid", paymentMethod: "cash" });
    expect("value" in r && r.value.paymentMethod).toBeNull();
  });
  it("zero / negative qty refused", () => {
    expect(validateBill({ ...base, lines: [{ ...base.lines[0], qty: 0 }], total: 55 })).toHaveProperty("error");
  });
});

describe("error messages", () => {
  it("maps RPC errors without leaking SQL", () => {
    expect(purchaseErrorMessage('duplicate key value violates unique constraint "purchase_bills_supplier_no_unique_idx"')).toBe("บิลเลขนี้ของผู้ขายรายนี้บันทึกไปแล้ว");
    expect(purchaseErrorMessage("insufficient cash in drawer")).toContain("เงินสด");
    expect(purchaseErrorMessage("relation x does not exist")).toBe("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
  });
});

describe("A1 migration contracts", () => {
  it("negative stock is reset before receiving, at the old average cost", () => {
    expect(sql).toContain("if v_stock.on_hand < 0 then insert into public.ingredient_movements");
    expect(sql).toContain("'negative_reset', -v_stock.on_hand, v_stock.on_hand, 0, v_stock.avg_unit_cost");
    expect(sql).toContain("v_avg := case when v_stock.on_hand <= 0 then p_unit_cost");
  });
  it("stock row is locked while receiving and voiding", () => {
    expect((sql.match(/from public\.ingredient_stock where ingredient_id = [^;]+ for update/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("void only returns purchased qty and refunds via income (ledger stays continuous)", () => {
    expect(sql).toContain("'receive_void', -v_l.usage_qty");
    expect(sql).not.toMatch(/delete from public\.(transactions|cash_ledger_entries)/);
    expect(sql).toContain("'คืนเงินบิลซื้อ'");
  });
  it("cash payouts go through the drawer-checked expense helper", () => {
    expect(sql).toContain("public.resale_record_expense(");
  });
  it("bill total must equal lines − discount + VAT, duplicates blocked, RLS read-only", () => {
    expect(sql).toContain("raise exception 'bill total does not match lines'");
    expect(sql).toContain("create unique index if not exists purchase_bills_supplier_no_unique_idx");
    expect(sql).not.toMatch(/on public\.purchase_bill(s|_lines|_payments) for (insert|update|delete|all)/);
  });
  it("writing RPCs require manager + stockManagement + inventory switch", () => {
    expect(sql).toContain("public.organization_has_stock_management(p_org)");
    expect(sql).toContain("inventory is not enabled for this store");
    for (const fn of ["purchase_bill_post(uuid, jsonb)", "purchase_bill_pay(uuid, text)", "purchase_bill_void(uuid, text)"]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon`);
    }
  });
});

describe("wiring", () => {
  it("every action passes a gate and logs (submit/upload = staff gate, others = inventory gate)", () => {
    const src = read("src/app/(dashboard)/costing/purchase-actions.ts");
    const exported = src.match(/export async function \w+/g) ?? [];
    expect(exported.length).toBe(8);
    expect((src.match(/await editor\(\)/g) ?? []).length).toBe(5);
    expect(src).toContain('source: "purchasing"');
  });
});
