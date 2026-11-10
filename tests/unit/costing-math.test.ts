import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  campaignMinSales,
  deliveryPriceForCommission,
  foodCostPct,
  ingredientUnitCost,
  plateIngredientCost,
  roundPrice,
  salesTargets,
  suggestedPriceForFoodCost,
} from "@/modules/costing/math";
import {
  allocationSum,
  effectiveAllocation,
  menuAllocationCard,
  validateAllocation,
} from "@/modules/costing/allocation";
import { DEFAULT_ALLOCATION, type AllocationTemplate, type RecipeLine } from "@/modules/costing/types";

const ing = (purchasePrice: number, usagePerPurchase: number, yieldPct = 100) => ({ purchasePrice, usagePerPurchase, yieldPct });

describe("ต้นทุนวัตถุดิบ (fixture v1 หัวข้อ 07)", () => {
  it("ไก่ 1 กก. 95 บาท ใช้ได้ 80% = 0.11875 บาท/กรัม · 80 กรัม = 9.50", () => {
    expect(ingredientUnitCost(ing(95, 1000, 80))).toBeCloseTo(0.11875, 10);
    const lines: RecipeLine[] = [{ id: "l1", productId: "p", variantId: null, ingredientId: "chicken", quantity: 80 }];
    expect(plateIngredientCost(lines, new Map([["chicken", ing(95, 1000, 80)]]), "p", null)).toBe(9.5);
  });

  it("ข้าวมันไก่ 17.50 → เป้า 35% = 50 บาท · GP 30% = เดลิเวอรี 72 บาท", () => {
    expect(suggestedPriceForFoodCost(17.5, 35, "ceil_1")).toBe(50);
    expect(deliveryPriceForCommission(50, 30, "ceil_1")).toBe(72);
    expect(foodCostPct(17.5, 50)).toBeCloseTo(35, 10);
  });

  it("สูตรใช้บรรทัดทุกตัวเลือก + บรรทัดของตัวเลือกที่ขาย และ null เมื่อไม่มีสูตร", () => {
    const ingredients = new Map([
      ["rice", ing(40, 1000)],
      ["egg", ing(5, 1)],
    ]);
    const lines: RecipeLine[] = [
      { id: "1", productId: "p", variantId: null, ingredientId: "rice", quantity: 100 },
      { id: "2", productId: "p", variantId: "special", ingredientId: "egg", quantity: 1 },
    ];
    expect(plateIngredientCost(lines, ingredients, "p", null)).toBe(4);
    expect(plateIngredientCost(lines, ingredients, "p", "special")).toBe(9);
    expect(plateIngredientCost(lines, ingredients, "other", null)).toBeNull();
  });

  it("ปัดราคาตามกติกาของร้าน", () => {
    expect(roundPrice(71.43, "ceil_1")).toBe(72);
    expect(roundPrice(71.43, "ceil_5")).toBe(75);
    expect(roundPrice(71.43, "ceil_10")).toBe(80);
    expect(roundPrice(71.426, "none")).toBe(71.43);
    expect(roundPrice(17.5 / 0.35, "ceil_1")).toBe(50);
  });
});

describe("เป้ายอดขาย 7 ขั้น (fixture v1 หัวข้อ 07)", () => {
  it("ต้นทุนคงที่ 50,000 · ผันแปร 40% · กำไร 30,000 · 26 วัน · บิล 120 → 43 บิล/วัน", () => {
    const r = salesTargets({ fixedCostMonthly: 50000, variablePct: 40, targetProfitMonthly: 30000, openDaysPerMonth: 26, avgBill: 120 });
    expect(Math.ceil(r.breakEvenMonth!)).toBe(83334);
    expect(Math.ceil(r.targetMonth!)).toBe(133334);
    expect(Math.ceil(r.targetDay!)).toBe(5129);
    expect(r.billsPerDay).toBe(43);
    expect(Math.ceil(campaignMinSales(3500, r.contribution)!)).toBe(5834);
  });

  it("ต้นทุนผันแปร ≥ 100% คำนวณไม่ได้", () => {
    expect(salesTargets({ fixedCostMonthly: 1, variablePct: 100, targetProfitMonthly: 0, openDaysPerMonth: 26, avgBill: 1 }).targetMonth).toBeNull();
  });
});

describe("การ์ดสัดส่วน 5 ส่วน (ภาพชาไทย 35 บาทใน v2)", () => {
  const card = menuAllocationCard({ price: 35, ingredientCost: 11.2, packagingCost: 3.5, pcts: DEFAULT_ALLOCATION, rounding: "ceil_1" });

  it("แสดงค่าตรงตามภาพทุกบรรทัด", () => {
    const by = Object.fromEntries(card.lines.map((l) => [l.bucket, l]));
    expect(by.ingredient).toMatchObject({ targetAmount: 10.5, actualAmount: 11.2, actualPct: 32, offTarget: true });
    expect(by.packaging).toMatchObject({ targetAmount: 3.5, actualAmount: 3.5, actualPct: 10, offTarget: false });
    expect(by.labor).toMatchObject({ actualAmount: 3.5, actualPct: 10 });
    expect(by.overhead).toMatchObject({ actualAmount: 5.25, actualPct: 15 });
    expect(by.profit).toMatchObject({ targetAmount: 12.25, actualAmount: 11.55, actualPct: 33, offTarget: true });
  });

  it("ราคาที่ทำให้กำไรกลับไป 35% = 14.70 ÷ 0.40 = 36.75 → 37", () => {
    expect(card.priceForTarget).toBe(37);
  });

  it("เมนูไม่มีสูตร → ไม่แนะนำราคา", () => {
    const none = menuAllocationCard({ price: 35, ingredientCost: null, packagingCost: 0, pcts: DEFAULT_ALLOCATION, rounding: "ceil_1" });
    expect(none.hasRecipe).toBe(false);
    expect(none.priceForTarget).toBeNull();
  });
});

describe("ตรวจและเลือกสัดส่วน", () => {
  it("ต้องรวม 100% และแต่ละส่วน 0–100", () => {
    expect(validateAllocation(DEFAULT_ALLOCATION)).toBeNull();
    expect(validateAllocation({ ...DEFAULT_ALLOCATION, profit: 30 })).toContain("100%");
    expect(validateAllocation({ ...DEFAULT_ALLOCATION, labor: -5, profit: 50 })).toContain("0–100");
    expect(allocationSum({ ingredient: 33.33, packaging: 33.33, labor: 33.34, overhead: 0, profit: 0 })).toBe(100);
  });

  it("ใช้ของเมนูก่อน ถ้าไม่มีใช้ของร้าน และเลือกตามวันที่มีผล", () => {
    const t = (id: string, productId: string | null, effectiveFrom: string, profit: number): AllocationTemplate => ({
      id,
      productId,
      effectiveFrom,
      pcts: { ...DEFAULT_ALLOCATION, overhead: 50 - profit, profit },
    });
    const templates = [
      t("store-old", null, "2026-01-01T00:00:00Z", 35),
      t("store-new", null, "2026-06-01T00:00:00Z", 30),
      t("menu", "p1", "2026-03-01T00:00:00Z", 40),
    ];
    expect(effectiveAllocation(templates, "p1", new Date("2026-07-01"))?.id).toBe("menu");
    expect(effectiveAllocation(templates, "p2", new Date("2026-07-01"))?.id).toBe("store-new");
    expect(effectiveAllocation(templates, "p2", new Date("2026-02-01"))?.id).toBe("store-old");
    expect(effectiveAllocation(templates, "p1", new Date("2026-02-01"))?.id).toBe("store-old");
    expect(effectiveAllocation([], null)).toBeNull();
  });

  it("แถว use_store_default ทำให้เมนูกลับไปใช้ค่าร้านโดยไม่ลบประวัติ", () => {
    const store: AllocationTemplate = { id: "s", productId: null, effectiveFrom: "2026-01-01T00:00:00Z", pcts: DEFAULT_ALLOCATION };
    const menu: AllocationTemplate = { id: "m", productId: "p1", effectiveFrom: "2026-02-01T00:00:00Z", pcts: { ...DEFAULT_ALLOCATION, overhead: 10, profit: 40 } };
    const back: AllocationTemplate = { ...menu, id: "back", effectiveFrom: "2026-05-01T00:00:00Z", useStoreDefault: true };
    expect(effectiveAllocation([store, menu, back], "p1", new Date("2026-03-01"))?.id).toBe("m");
    expect(effectiveAllocation([store, menu, back], "p1", new Date("2026-06-01"))?.id).toBe("s");
  });
});

describe("SQL ↔ TS parity และความปลอดภัยของ migration", () => {
  const snapshot = readFileSync("supabase/migrations/20261109000002_costing_order_item_snapshot.sql", "utf8");
  const foundation = readFileSync("supabase/migrations/20261109000001_costing_foundation.sql", "utf8");

  it("SQL ใช้สูตรต้นทุนต่อหน่วยเดียวกับ math.ts และปัด 4 ตำแหน่ง", () => {
    expect(snapshot).toContain("rl.quantity * (i.purchase_price / i.usage_per_purchase / (i.yield_pct / 100))");
    expect(snapshot).toContain("(rl.variant_id is null or rl.variant_id = p_variant_id)");
    expect(snapshot).toContain("round(sum(line_cost), 4)");
  });

  it("trigger ห้ามทำให้การขายล้ม และผู้ใช้เรียกฟังก์ชันต้นทุนตรงไม่ได้", () => {
    expect(snapshot).toContain("after insert on public.order_items");
    expect(snapshot).toMatch(/exception when others then\s+raise warning/);
    expect(snapshot).toContain("revoke all on function public.costing_plate_cost(uuid, uuid) from public, anon, authenticated;");
    expect(snapshot).not.toMatch(/grant execute on function public\.costing_plate_cost/);
    expect(snapshot).toContain("auth_user_role_in_store(organization_id, store_id, 'manager')");
  });

  it("บันทึกสูตรเป็นธุรกรรมเดียวผ่าน RPC แบบ security invoker และกันสูตรซ้ำ", () => {
    const fn = foundation.slice(foundation.indexOf("create or replace function public.costing_save_menu"));
    expect(fn).toContain("security invoker");
    expect(fn).not.toContain("security definer");
    expect(fn).toContain("auth_user_role_in_store(v_org, v_store, 'manager')");
    expect(foundation).toContain("recipe_lines_unique_ingredient_idx");
    expect(foundation).toContain("use_store_default boolean not null default false");
    expect(snapshot).toContain("if v_unit_cost is null and coalesce(v_packaging, 0) = 0 then");
  });

  it("ตารางต้นทุนทุกตารางเปิด RLS ระดับ manager และไม่แก้ products/order_items", () => {
    for (const table of ["store_cost_settings", "store_cost_budgets", "ingredients", "ingredient_price_history", "recipe_lines", "product_cost_settings", "cost_allocation_templates"]) {
      expect(foundation).toContain(`alter table public.${table} enable row level security;`);
    }
    expect(foundation).not.toMatch(/alter table public\.(products|order_items)/);
    expect(foundation).toContain("check (ingredient_pct + packaging_pct + labor_pct + overhead_pct + profit_pct = 100)");
  });
});
