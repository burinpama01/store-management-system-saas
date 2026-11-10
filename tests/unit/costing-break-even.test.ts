import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actualUnitsPerMonth,
  breakEvenUnits,
  groupActualExpenses,
  laborDoubleCountRisk,
  mixContribution,
  monthlyDepreciation,
  monthlyProfit,
  netProfitAt,
  overheadPerUnit,
  paybackMonths,
  previousMonthRange,
  priceForNetMargin,
  priceLadder,
  summarizeFixedCosts,
  type CostBudget,
} from "@/modules/costing/break-even";

const budget = (over: Partial<CostBudget>): CostBudget => ({
  id: "b",
  kind: "monthly",
  costType: "rent",
  name: "x",
  amount: 0,
  usefulLifeMonths: null,
  isActive: true,
  ...over,
});

describe("ต้นทุนคงที่ + ค่าเสื่อม", () => {
  it("รวมรายเดือน + ค่าเสื่อม และข้ามรายการปิด/ผันแปร", () => {
    const s = summarizeFixedCosts([
      budget({ amount: 25000 }),
      budget({ costType: "utility", amount: 6000 }),
      budget({ costType: "labor", amount: 24000 }),
      budget({ costType: "ingredient", amount: 9999 }),
      budget({ costType: "other", amount: 500, isActive: false }),
      budget({ kind: "startup", costType: "maintenance", amount: 180000, usefulLifeMonths: 60 }),
      budget({ kind: "startup", costType: "other", amount: 50000, usefulLifeMonths: null }),
    ]);
    expect(s.monthly).toBe(55000);
    expect(s.depreciation).toBe(3000);
    expect(s.total).toBe(58000);
    expect(s.startupTotal).toBe(230000);
    expect(s.startupWithoutLife).toBe(1);
    expect(s.skippedVariable).toBe(1);
    expect(s.byType).toEqual({ rent: 25000, utility: 6000, labor: 24000 });
  });

  it("ค่าเสื่อมคิดเฉพาะเงินลงทุนที่มีอายุใช้งาน", () => {
    expect(monthlyDepreciation({ kind: "startup", amount: 120000, usefulLifeMonths: 24 })).toBe(5000);
    expect(monthlyDepreciation({ kind: "monthly", amount: 120000, usefulLifeMonths: 24 })).toBe(0);
    expect(monthlyDepreciation({ kind: "startup", amount: 120000, usefulLifeMonths: 0 })).toBe(0);
  });
});

describe("กำไรส่วนเกินถ่วงตามยอดขาย", () => {
  it("ถ่วงด้วยจำนวนชิ้น ไม่นับเมนูที่ไม่มีสูตร และหักผันแปรอื่น%", () => {
    const r = mixContribution(
      [
        { productId: "a", name: "ลาเต้", qty: 30, price: 80, unitCost: 30 },
        { productId: "b", name: "อเมริกาโน่", qty: 10, price: 60, unitCost: 20 },
        { productId: "c", name: "เค้ก", qty: 40, price: 70, unitCost: null },
      ],
      5,
    );
    // ลาเต้ 80-30-4=46, อเมริกาโน่ 60-20-3=37 → (46*30+37*10)/40 = 43.75
    expect(r.avgContribution).toBe(43.75);
    expect(r.coveredQty).toBe(40);
    expect(r.totalQty).toBe(80);
    expect(r.coveragePct).toBe(50);
    expect(r.negative).toEqual([]);
  });

  it("เมนูที่ราคาต่ำกว่าต้นทุนถูกรายงาน · ไม่มีสูตรเลย = null", () => {
    const r = mixContribution([{ productId: "a", name: "ขาดทุน", qty: 5, price: 20, unitCost: 25 }], 0);
    expect(r.negative[0]).toMatchObject({ productId: "a", contribution: -5 });
    expect(mixContribution([{ productId: "c", name: "x", qty: 5, price: 70, unitCost: null }], 0).avgContribution).toBeNull();
  });
});

describe("จุดคุ้มทุน", () => {
  it("ต้นทุนคงที่ ÷ กำไรต่อชิ้น ปัดขึ้น + ต่อวัน + ถึงเป้ากำไร", () => {
    const r = breakEvenUnits({ fixedMonthly: 59200, contribution: 40.2, targetProfitMonthly: 20000, openDaysPerMonth: 26 });
    expect(r.monthUnits).toBe(1473);
    expect(r.dayUnits).toBe(57);
    expect(r.targetMonthUnits).toBe(1971);
    expect(r.targetDayUnits).toBe(76);
  });

  it("กำไรต่อชิ้น ≤ 0 → คุ้มทุนไม่ได้ (ไม่หารด้วยศูนย์)", () => {
    expect(breakEvenUnits({ fixedMonthly: 1000, contribution: 0, targetProfitMonthly: 0, openDaysPerMonth: 26 }).monthUnits).toBeNull();
    expect(breakEvenUnits({ fixedMonthly: 1000, contribution: null, targetProfitMonthly: 0, openDaysPerMonth: 26 }).dayUnits).toBeNull();
  });

  it("ตัวเลขลงตัวพอดีไม่ปัดเกิน (ลอยจุด)", () => {
    expect(breakEvenUnits({ fixedMonthly: 30, contribution: 0.1, targetProfitMonthly: 0, openDaysPerMonth: 30 }).monthUnits).toBe(300);
  });
});

describe("ตั้งราคาตามกำไรสุทธิ — ตัวอย่างจากคลิป", () => {
  it("ต้นทุนรวม 70.53 กำไรสุทธิ 30% → 101 บาท", () => {
    expect(priceForNetMargin({ fullUnitCost: 70.53, netMarginPct: 30, otherVariablePct: 0, rounding: "ceil_1" })).toBe(101);
    expect(priceForNetMargin({ fullUnitCost: 70.53, netMarginPct: 10, otherVariablePct: 0, rounding: "none" })).toBe(78.37);
  });

  it("ตารางราคา 10–30% + กำไรต่อชิ้น", () => {
    const ladder = priceLadder({ fullUnitCost: 70.53, otherVariablePct: 0, rounding: "ceil_1" });
    expect(ladder.map((r) => r.price)).toEqual([79, 83, 89, 95, 101]);
    expect(ladder[4].profitPerUnit).toBe(30.47);
  });

  it("กำไรเป้า + ผันแปรรวม ≥ 100% คำนวณไม่ได้", () => {
    expect(priceForNetMargin({ fullUnitCost: 50, netMarginPct: 70, otherVariablePct: 30, rounding: "none" })).toBeNull();
  });

  it("กำไรสุทธิที่ราคาปัจจุบัน", () => {
    expect(netProfitAt(90, 70.53, 0)).toEqual({ perUnit: 19.47, pct: 21.6 });
  });
});

describe("ต่อชิ้น / คืนทุน / ยอดจริง", () => {
  it("ต้นทุนดำเนินการต่อชิ้น", () => {
    expect(overheadPerUnit(59200, 1066)).toBe(55.53);
    expect(overheadPerUnit(59200, 0)).toBeNull();
  });

  it("กำไรต่อเดือน + ระยะคืนทุน", () => {
    expect(monthlyProfit(2000, 40, 60000)).toBe(20000);
    expect(paybackMonths(230000, 20000)).toBe(12);
    expect(paybackMonths(230000, -1)).toBeNull();
    expect(paybackMonths(0, 20000)).toBeNull();
  });

  it("ชิ้นต่อเดือนจากยอดจริง = ยอดช่วงปฏิทิน → ต่อ 30 วัน · ต่อวัน = ÷ วันเปิดร้าน", () => {
    expect(actualUnitsPerMonth(1066, 30, 26)).toEqual({ perDay: 41, perMonth: 1066 });
    // ช่วง 15 วัน ขาย 533 → ต่อเดือน 1,066 (ร้านปิดบางวันไม่ทำให้ค่าเฉลี่ยพอง)
    expect(actualUnitsPerMonth(533, 15, 26)).toEqual({ perDay: 41, perMonth: 1066 });
    expect(actualUnitsPerMonth(0, 30, 26)).toBeNull();
  });
});

describe("รายจ่ายจริง", () => {
  it("รวมตามประเภท ข้ามผันแปร เก็บหมวดที่ยังไม่ระบุแยก", () => {
    const r = groupActualExpenses([
      { amount: 25000, costType: "rent" },
      { amount: 3000, costType: "utility" },
      { amount: 4240, costType: "utility" },
      { amount: 8000, costType: "ingredient" },
      { amount: 1500, costType: null },
      { amount: 200, costType: "weird" },
    ]);
    expect(r.byType).toEqual({ rent: 25000, utility: 7240 });
    expect(r.unmapped).toBe(1700);
  });

  it("เตือนค่าแรงนับซ้ำเมื่อมีทั้งหมวดค่าแรงและเงินเดือน", () => {
    expect(laborDoubleCountRisk({ byType: { labor: 1000 }, unmapped: 0, payrollNet: 23500 })).toBe(true);
    expect(laborDoubleCountRisk({ byType: {}, unmapped: 0, payrollNet: 23500 })).toBe(false);
  });

  it("เดือนก่อนหน้า (ข้ามปี, ก.พ.)", () => {
    expect(previousMonthRange("2026-11-10")).toEqual({ from: "2026-10-01", to: "2026-10-31", label: "10/2026" });
    expect(previousMonthRange("2027-01-05")).toEqual({ from: "2026-12-01", to: "2026-12-31", label: "12/2026" });
    expect(previousMonthRange("2028-03-01").to).toBe("2028-02-29");
  });
});

describe("wiring หน้า /costing/break-even (source)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("action ทุกตัวตรวจสิทธิ์ + log source costing.break_even", () => {
    const src = read("src/app/(dashboard)/costing/break-even/actions.ts");
    for (const fn of ["saveCostBudgetAction", "deleteCostBudgetAction", "saveBreakEvenSettingsAction", "setCategoryCostTypeAction"]) {
      expect(src).toContain(`export async function ${fn}`);
    }
    expect(src.match(/await requireEditor\(\)/g)?.length).toBe(4);
    expect(src.match(/await logBreakEven\(/g)?.length).toBe(4);
    expect(src).toContain('source: "costing.break_even"');
  });

  it("เขียน/ลบตรวจ 0 แถว (RLS ปฏิเสธเงียบ) และรายจ่ายดึงทีละหน้า", () => {
    const src = read("src/modules/costing/break-even-repository.ts");
    expect(src).toContain('.from("store_cost_budgets").delete().eq("id", id).eq("store_id", storeId).select("id")');
    expect(src).toContain("data.length === 0");
    expect(src).toContain('.order("id")');
    expect(src).toContain(".range(from, from + PAGE - 1)");
    // งวดเงินเดือนที่ reopened (กำลังแก้) ไม่นับ
    expect(src).toContain('.eq("status", "closed")');
  });

  it("แท็บจุดคุ้มทุนอยู่ในเมนูต้นทุน · input 16px กัน iOS ซูม · ลบต้องยืนยัน", () => {
    expect(read("src/app/(dashboard)/costing/CostingChrome.tsx")).toContain('{ href: "/costing/break-even", label: "จุดคุ้มทุน" }');
    const ui = read("src/app/(dashboard)/costing/break-even/BreakEvenPlanner.tsx");
    expect(ui).toContain("const INPUT_STYLE = { fontSize: 16 }");
    expect(ui).toContain("useConfirm()");
    expect(ui).toContain("danger: true");
  });
});

describe("migration ผูก store/org ของตารางต้นทุน", () => {
  it("composite FK ไป stores(id, organization_id) ครบ 6 ตาราง และรันซ้ำได้", () => {
    const sql = readFileSync("supabase/migrations/20261110120000_costing_store_org_fk.sql", "utf8");
    for (const t of ["store_cost_settings", "store_cost_budgets", "ingredients", "recipe_lines", "product_cost_settings", "cost_allocation_templates"]) {
      expect(sql).toContain(`'${t}'`);
    }
    expect(sql).toContain("foreign key (store_id, organization_id) references public.stores(id, organization_id) on delete cascade");
    expect(sql).toContain("exception when duplicate_object then null");
  });
});
