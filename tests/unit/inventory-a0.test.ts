import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideInventoryAccess } from "@/modules/inventory/access-policy";
import {
  stockStatus,
  stockValue,
  suggestedReorderPoint,
  toPurchaseUnits,
  toUsageUnits,
  unitCostFromPurchasePrice,
  weightedAverageCost,
} from "@/modules/inventory/math";
import { inventoryErrorMessage } from "@/modules/inventory/repository";
import { validateSupplier } from "@/modules/inventory/validate";
import { branchLabel, isValidBranchCode, isValidThaiTaxId } from "@/shared/utils/thai-tax-id";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20261202120000_ingredient_inventory_a0.sql"), "utf8")
  .toLowerCase()
  .replace(/\s+/g, " ");

describe("inventory math", () => {
  it("converts purchase units ↔ usage units", () => {
    expect(toUsageUnits(3, 1000)).toBe(3000);
    expect(toUsageUnits(0.25, 1000)).toBe(250);
    expect(toPurchaseUnits(2500, 1000)).toBe(2.5);
    expect(() => toUsageUnits(1, 0)).toThrow();
  });

  it("derives unit cost per usage unit from purchase price", () => {
    expect(unitCostFromPurchasePrice(180, 1000)).toBe(0.18);
    expect(unitCostFromPurchasePrice(45, 700)).toBeCloseTo(0.064286, 6);
  });

  it("computes weighted average cost like the prepy example (170 & 185 → 179)", () => {
    // 2 กก. @170 แล้วรับ 3 กก. @185 → (2×170 + 3×185) / 5 = 179
    expect(weightedAverageCost({ onHand: 2000, avgUnitCost: 0.17, qtyIn: 3000, unitCostIn: 0.185 })).toBeCloseTo(0.179, 6);
  });

  it("uses the incoming cost when stock is zero or negative", () => {
    expect(weightedAverageCost({ onHand: 0, avgUnitCost: 0.5, qtyIn: 100, unitCostIn: 0.2 })).toBe(0.2);
    expect(weightedAverageCost({ onHand: -300, avgUnitCost: 0.5, qtyIn: 100, unitCostIn: 0.2 })).toBe(0.2);
  });

  it("keeps the average when nothing is received", () => {
    expect(weightedAverageCost({ onHand: 100, avgUnitCost: 0.5, qtyIn: 0, unitCostIn: 9 })).toBe(0.5);
  });

  it("suggests reorder point = daily usage × (lead + safety days)", () => {
    expect(suggestedReorderPoint(500, 1, 2)).toBe(1500);
    expect(suggestedReorderPoint(0, 1, 2)).toBe(0);
    expect(suggestedReorderPoint(100, -3, 2)).toBe(200);
  });

  it("classifies stock status", () => {
    expect(stockStatus(null, 10)).toBe("unset");
    expect(stockStatus(-1, 10)).toBe("negative");
    expect(stockStatus(0, 10)).toBe("out");
    expect(stockStatus(10, 10)).toBe("low");
    expect(stockStatus(11, 10)).toBe("ok");
    expect(stockStatus(5, null)).toBe("ok");
  });

  it("values only positive stock", () => {
    expect(stockValue(2000, 0.179)).toBe(358);
    expect(stockValue(-5, 1)).toBe(0);
    expect(stockValue(null, 1)).toBe(0);
  });
});

describe("thai tax id", () => {
  it("validates the 13-digit checksum", () => {
    expect(isValidThaiTaxId("0105536092641")).toBe(true);
    expect(isValidThaiTaxId("0-1055-36092-64-1")).toBe(true);
    expect(isValidThaiTaxId("0105536092642")).toBe(false);
    expect(isValidThaiTaxId("123")).toBe(false);
  });

  it("labels branch codes", () => {
    expect(isValidBranchCode("00000")).toBe(true);
    expect(isValidBranchCode("0001")).toBe(false);
    expect(branchLabel("00000")).toBe("สำนักงานใหญ่");
    expect(branchLabel("00012")).toBe("สาขาที่ 00012");
  });
});

describe("supplier validation", () => {
  const base = {
    id: null,
    name: "  ตลาดสด เจ๊หมวย ",
    taxId: null,
    branchCode: null,
    contactName: " ",
    phone: "081",
    lineId: null,
    address: null,
    note: null,
    leadDays: 1,
    paymentTermsDays: 0,
    isActive: true,
  };

  it("trims fields and turns blanks into null", () => {
    const result = validateSupplier(base);
    expect("value" in result && result.value.name).toBe("ตลาดสด เจ๊หมวย");
    expect("value" in result && result.value.contactName).toBeNull();
  });

  it("rejects bad tax id / branch / ranges", () => {
    expect(validateSupplier({ ...base, name: "" })).toHaveProperty("error");
    expect(validateSupplier({ ...base, taxId: "0105536092642" })).toHaveProperty("error");
    expect(validateSupplier({ ...base, branchCode: "12" })).toHaveProperty("error");
    expect(validateSupplier({ ...base, leadDays: 61 })).toHaveProperty("error");
    expect(validateSupplier({ ...base, paymentTermsDays: 1.5 })).toHaveProperty("error");
  });

  it("defaults branch to head office when a tax id is given", () => {
    const result = validateSupplier({ ...base, taxId: "0105536092641" });
    expect("value" in result && result.value.branchCode).toBe("00000");
  });
});

describe("inventory access", () => {
  const costingOk = { allowed: true as const, canEdit: true };

  it("requires costing access and stockManagement", () => {
    expect(decideInventoryAccess({ costing: { allowed: false, reason: "role", message: "x" }, hasStockManagement: true, role: "owner", enabled: true }).allowed).toBe(false);
    expect(decideInventoryAccess({ costing: costingOk, hasStockManagement: false, role: "owner", enabled: true }).allowed).toBe(false);
  });

  it("only edits balances when the store switch is on, but suppliers work before", () => {
    const off = decideInventoryAccess({ costing: costingOk, hasStockManagement: true, role: "manager", enabled: false });
    expect(off).toMatchObject({ allowed: true, canEdit: false, canManageSuppliers: true, canToggle: false });
    const on = decideInventoryAccess({ costing: costingOk, hasStockManagement: true, role: "owner", enabled: true });
    expect(on).toMatchObject({ allowed: true, canEdit: true, canToggle: true });
  });
});

describe("inventory error messages", () => {
  it("never leaks raw SQL text", () => {
    expect(inventoryErrorMessage("inventory is not enabled for this store")).toBe("สาขานี้ยังไม่ได้เปิดคลังวัตถุดิบ");
    expect(inventoryErrorMessage("manual adjustment requires a reason")).toBe("กรุณาระบุเหตุผลที่ปรับยอด");
    expect(inventoryErrorMessage("some internal pg error at line 3")).toBe("บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง");
  });
});

describe("inventory A0 migration", () => {
  it("adds a per-store switch that is off by default", () => {
    expect(migration).toContain("add column if not exists inventory_enabled boolean not null default false");
  });

  it("keeps the movement ledger append-only and tenant-safe", () => {
    expect(migration).toContain("before update or delete on public.ingredient_movements");
    expect(migration).toContain("check (after_qty = before_qty + qty_delta)");
    expect(migration).toContain("ingredient_id uuid not null references public.ingredients(id) on delete restrict");
    expect(migration).toContain("ingredient must belong to the same store");
    // ไม่มี policy เขียนบนยอด/สมุด — เขียนผ่าน RPC เท่านั้น
    expect(migration).not.toMatch(/create policy "ingredient_(stock|movements)_[a-z_]*" on public\.ingredient_(stock|movements) for (all|insert|update|delete)/);
  });

  it("enables RLS on every new table at manager level", () => {
    for (const table of ["suppliers", "ingredient_stock", "ingredient_movements"]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(migration).toContain("auth_user_role_in_store(organization_id, store_id, 'manager')");
  });

  it("guards the balance RPC by role, plan, switch and locks the stock row", () => {
    const fn = migration.slice(migration.indexOf("function public.inventory_set_balance"));
    expect(fn).toContain("security definer");
    expect(fn).toContain("auth.uid() is null");
    expect(fn).toContain("organization_has_stock_management");
    expect(fn).toContain("inventory_enabled");
    expect(fn).toContain("for update");
    expect(fn).toContain("manual adjustment requires a reason");
    expect(migration).toContain("revoke all on function public.inventory_set_balance(uuid, text, numeric, text, numeric) from public, anon");
  });

  it("lets only owner/admin toggle the switch", () => {
    const fn = migration.slice(migration.indexOf("function public.inventory_set_enabled"));
    expect(fn).toContain("auth_user_role_in_store(v_org, p_store_id, 'admin')");
  });
});
