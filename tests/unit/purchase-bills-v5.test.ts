import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canApproveBill, decidePurchaseSubmit, needsApproval } from "@/modules/purchasing/access-policy";
import { buildEvidenceCsv, evidenceFileName, orphanFileName, safeFilePart } from "@/modules/purchasing/evidence-export";
import { purchaseErrorMessage } from "@/modules/purchasing/repository";
import type { PurchaseBill } from "@/modules/purchasing/types";
import { validateBill } from "@/modules/purchasing/validate";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const sql = read("supabase/migrations/20261206120000_purchase_bills_a1.sql").toLowerCase().replace(/\s+/g, " ");
const ING = "11111111-1111-4111-8111-111111111111";
const IMG = "33333333-3333-4333-8333-333333333333";

const bill = {
  supplierId: null,
  supplierName: "ตลาดสดเช้า",
  billNo: null,
  billDate: "2026-11-22",
  evidenceKind: "handwritten" as const,
  discount: 0,
  vatAmount: 0,
  total: 80,
  paymentStatus: "paid" as const,
  paymentMethod: "cash" as const,
  dueDate: null,
  note: null,
  source: "manual" as const,
  imageIds: [IMG],
  lines: [{ ingredientId: ING, expenseCategoryId: null, rawName: "ผักกาด", qty: 2, unitLabel: null, unitPrice: 40, lineTotal: 80 }],
};

describe("v5 handwritten bills + approval (pure)", () => {
  it("handwritten bill needs a photo", () => {
    expect(validateBill({ ...bill, imageIds: [] })).toEqual({ error: "บิลเขียนมือต้องแนบรูปบิลอย่างน้อย 1 รูป" });
    expect("value" in validateBill(bill)).toBe(true);
  });
  it("rejects unknown evidence kind, bad image ids, too many images", () => {
    expect(validateBill({ ...bill, evidenceKind: "x" as never })).toHaveProperty("error");
    expect(validateBill({ ...bill, imageIds: ["nope"] })).toHaveProperty("error");
    expect(validateBill({ ...bill, imageIds: Array.from({ length: 11 }, (_, i) => `33333333-3333-4333-8333-3333333333${String(i).padStart(2, "0")}`) })).toHaveProperty("error");
  });
  it("dedupes image ids", () => {
    const r = validateBill({ ...bill, imageIds: [IMG, IMG] });
    expect("value" in r && r.value.imageIds).toEqual([IMG]);
  });
  it("who needs approval (matches DB rule)", () => {
    expect(needsApproval("owner", "handwritten")).toBe(false);
    expect(needsApproval("manager", "handwritten")).toBe(true);
    expect(needsApproval("manager", "receipt")).toBe(false);
    expect(needsApproval("cashier", "receipt")).toBe(true);
    expect(needsApproval("staff", "tax_invoice")).toBe(true);
  });
  it("no self-approval except owner", () => {
    expect(canApproveBill({ role: "manager", userId: "a", postedBy: "a" })).toBe(false);
    expect(canApproveBill({ role: "manager", userId: "a", postedBy: "b" })).toBe(true);
    expect(canApproveBill({ role: "owner", userId: "a", postedBy: "a" })).toBe(true);
    expect(canApproveBill({ role: "cashier", userId: "a", postedBy: "b" })).toBe(false);
  });
  it("submit gate: stockManagement + inventory switch, any role", () => {
    expect(decidePurchaseSubmit({ hasStockManagement: false, inventoryEnabled: true, role: "staff" }).allowed).toBe(false);
    expect(decidePurchaseSubmit({ hasStockManagement: true, inventoryEnabled: false, role: "staff" }).allowed).toBe(false);
    expect(decidePurchaseSubmit({ hasStockManagement: true, inventoryEnabled: true, role: "staff" })).toEqual({ allowed: true, isManager: false, isOwner: false });
  });
  it("maps new RPC errors", () => {
    expect(purchaseErrorMessage("cannot approve own bill")).toContain("อนุมัติบิลที่ตัวเองส่งไม่ได้");
    expect(purchaseErrorMessage("handwritten bill requires a photo")).toContain("แนบรูป");
    expect(purchaseErrorMessage("bill is not pending")).toContain("ไม่ได้รออนุมัติ");
  });
});

describe("evidence export (pure)", () => {
  const b = {
    id: "abcdef12-0000-4000-8000-000000000000",
    billDate: "2026-11-22",
    billNo: "N6911/01829",
    supplierName: "ศุภชัย",
    supplierId: null,
    evidenceKind: "receipt",
    status: "posted",
    subtotal: 248,
    discount: 0,
    vatAmount: 0,
    total: 248,
    paymentStatus: "unpaid",
    paymentMethod: null,
    postedByName: "=HYPERLINK()",
    rejectReason: null,
    voidReason: null,
    images: [{ id: "i1", storagePath: "p", url: null }],
  } as unknown as PurchaseBill;
  it("file names are safe and sortable by date", () => {
    expect(safeFilePart('a/b:c*?"<>|')).toBe("a b c");
    expect(evidenceFileName(b, "ศุภชัย", 0)).toBe("2026-11-22_ศุภชัย_N6911 01829_1.jpg");
    expect(evidenceFileName({ ...b, billNo: null }, "ตลาด", 1)).toBe("2026-11-22_ตลาด_abcdef12_2.jpg");
    expect(orphanFileName({ id: "zzzzzzzz-1", createdAt: "2026-11-22T03:00:00Z" })).toBe("ไม่ผูกบิล/2026-11-22_zzzzzzzz.jpg");
  });
  it("CSV has header, Thai labels, and neutralises formulas", () => {
    const csv = buildEvidenceCsv([b], () => "ศุภชัย");
    const [header, row] = csv.split("\r\n");
    expect(header).toContain("ชนิดหลักฐาน");
    expect(row).toContain("ใบเสร็จ/บิลร้านค้า");
    expect(row).toContain("ค้างจ่าย");
    expect(row).toContain("'=HYPERLINK()");
  });
});

describe("v5 migration contracts", () => {
  it("pending bills do not touch stock until approved", () => {
    expect(sql).toContain("v_pending := not v_is_owner and (v_kind = 'handwritten' or not v_is_manager)");
    expect(sql).toContain("if not v_pending then v_applied := public.purchase_apply_stock(v_id, auth.uid())");
    expect(sql).toContain("raise exception 'cannot approve own bill'");
  });
  it("handwritten requires a linked photo; images only from this store and uploader", () => {
    expect(sql).toContain("raise exception 'handwritten bill requires a photo'");
    expect(sql).toContain("and (uploaded_by = auth.uid() or v_is_manager)");
    expect(sql).toContain("p_path not like (v_org::text || '/' || p_store_id::text || '/purchases/%')");
  });
  it("evidence bucket is private and images are never deleted by the app", () => {
    expect(sql).toContain("values ('purchase-evidence', 'purchase-evidence', false)");
    expect(sql).not.toMatch(/delete from public\.purchase_bill_images/);
    expect(read("src/app/(dashboard)/costing/purchase-actions.ts")).not.toMatch(/purchase_bill_images.*delete|\.from\("purchase_bill_images"\)\.delete/);
  });
  it("reject re-categorises paid expense, recover records income", () => {
    expect(sql).toContain("'รายจ่ายไม่อนุมัติ'");
    expect(sql).toContain("'รับคืนรายจ่ายไม่อนุมัติ'");
  });
  it("cash ledger rows in one transaction get strictly increasing created_at", () => {
    expect((sql.match(/greatest\(clock_timestamp\(\), v_prev_at \+ interval '1 microsecond'\)/g) ?? []).length).toBe(2);
  });
  it("staff only see their own bills/images via RLS", () => {
    expect(sql).toContain("posted_by = auth.uid() and auth_user_role_in_store(organization_id, store_id, 'staff')");
    expect(sql).toContain("uploaded_by = auth.uid() and auth_user_role_in_store(organization_id, store_id, 'staff')");
  });
});

describe("v5 wiring", () => {
  const actions = read("src/app/(dashboard)/costing/purchase-actions.ts");
  it("submit + upload use the staff gate; manager actions use the inventory gate", () => {
    expect((actions.match(/await getPurchaseSubmitAccess\(\)/g) ?? []).length).toBe(2);
    expect((actions.match(/await editor\(\)/g) ?? []).length).toBe(5);
    expect(actions).toContain('source: "purchasing"');
  });
  it("nav shows the staff submit page when inventory is on", () => {
    expect(read("src/app/(dashboard)/layout.tsx")).toContain('href: "/purchase-bills", label: "ส่งบิลซื้อ"');
  });
});
