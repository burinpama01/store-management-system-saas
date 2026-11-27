/**
 * จุดคุ้มทุน (Plan/Break-even Planner Plan v1.html) — ฟังก์ชันล้วน ไม่มี I/O
 * หน่วยนับเป็น "ชิ้น" (แก้ว/จาน/ชิ้น) · เงินเป็นบาท
 */
import { roundPrice, roundTo } from "./math";
import type { PriceRounding } from "./types";

/** ประเภทต้นทุนเดียวกับ accounting_categories.cost_type / store_cost_budgets.cost_type */
export const COST_TYPES = ["rent", "labor", "utility", "system", "marketing", "maintenance", "ingredient", "packaging", "other"] as const;
export type CostType = (typeof COST_TYPES)[number];

export const COST_TYPE_LABELS: Record<CostType, string> = {
  rent: "ค่าเช่า",
  labor: "ค่าแรง",
  utility: "ค่าน้ำ ค่าไฟ",
  system: "ค่าระบบ/อินเทอร์เน็ต",
  marketing: "การตลาด",
  maintenance: "ซ่อมบำรุง",
  ingredient: "วัตถุดิบ (ผันแปร)",
  packaging: "บรรจุภัณฑ์ (ผันแปร)",
  other: "อื่น ๆ",
};

/** ต้นทุนผันแปร (คิดอยู่ในต้นทุนต่อชิ้นแล้ว) — ห้ามนับซ้ำเป็นต้นทุนคงที่ */
export const VARIABLE_COST_TYPES: readonly CostType[] = ["ingredient", "packaging"];
export const FIXED_COST_TYPES: readonly CostType[] = COST_TYPES.filter((t) => !VARIABLE_COST_TYPES.includes(t));

export function isCostType(value: unknown): value is CostType {
  return typeof value === "string" && (COST_TYPES as readonly string[]).includes(value);
}

export type BudgetKind = "monthly" | "startup";

export interface CostBudget {
  id: string;
  kind: BudgetKind;
  costType: CostType;
  name: string;
  amount: number;
  /** เฉพาะเงินลงทุน: อายุใช้งาน (เดือน) → ค่าเสื่อม; null = ไม่คิดค่าเสื่อม */
  usefulLifeMonths: number | null;
  isActive: boolean;
}

/** รายการตัวอย่างให้กดเติม (รวมค่าใช้จ่ายที่ร้านใหม่มักลืม) */
export const BUDGET_PRESETS: Array<{ costType: CostType; name: string }> = [
  { costType: "rent", name: "ค่าเช่าที่" },
  { costType: "utility", name: "ค่าไฟ" },
  { costType: "utility", name: "ค่าน้ำ" },
  { costType: "labor", name: "ค่าแรงพนักงาน" },
  { costType: "labor", name: "ประกันสังคมส่วนนายจ้าง" },
  { costType: "system", name: "อินเทอร์เน็ต/ระบบ POS" },
  { costType: "marketing", name: "โฆษณา/การตลาด" },
  { costType: "maintenance", name: "ซ่อมบำรุงอุปกรณ์" },
  { costType: "other", name: "ค่าธรรมเนียมธนาคาร/ใบอนุญาต" },
  { costType: "other", name: "ของใช้สิ้นเปลือง (ทิชชู่ น้ำยา)" },
];

export function monthlyDepreciation(budget: Pick<CostBudget, "kind" | "amount" | "usefulLifeMonths">): number {
  if (budget.kind !== "startup" || !(budget.usefulLifeMonths && budget.usefulLifeMonths > 0)) return 0;
  return budget.amount / budget.usefulLifeMonths;
}

export interface FixedCostSummary {
  /** ต้นทุนคงที่ต่อเดือนรวมค่าเสื่อม */
  total: number;
  monthly: number;
  depreciation: number;
  byType: Partial<Record<CostType, number>>;
  /** เงินลงทุนทั้งหมด (ใช้คิดระยะคืนทุน) */
  startupTotal: number;
  /** รายการเงินลงทุนที่ไม่ได้ใส่อายุใช้งาน → ไม่อยู่ในต้นทุนคงที่ */
  startupWithoutLife: number;
  /** รายการรายเดือนที่เป็นประเภทผันแปร (วัตถุดิบ/บรรจุภัณฑ์) — ไม่นับ เพราะอยู่ในต้นทุนต่อชิ้นแล้ว */
  skippedVariable: number;
}

export function summarizeFixedCosts(budgets: CostBudget[]): FixedCostSummary {
  let monthly = 0;
  let depreciation = 0;
  let startupTotal = 0;
  let startupWithoutLife = 0;
  let skippedVariable = 0;
  const byType: Partial<Record<CostType, number>> = {};
  for (const budget of budgets) {
    if (!budget.isActive || !(budget.amount > 0)) continue;
    if (budget.kind === "monthly") {
      if (VARIABLE_COST_TYPES.includes(budget.costType)) {
        skippedVariable += 1;
        continue;
      }
      monthly += budget.amount;
      byType[budget.costType] = (byType[budget.costType] ?? 0) + budget.amount;
    } else {
      startupTotal += budget.amount;
      const dep = monthlyDepreciation(budget);
      if (dep > 0) depreciation += dep;
      else startupWithoutLife += 1;
    }
  }
  return {
    total: roundTo(monthly + depreciation),
    monthly: roundTo(monthly),
    depreciation: roundTo(depreciation),
    byType,
    startupTotal: roundTo(startupTotal),
    startupWithoutLife,
    skippedVariable,
  };
}

/** กำไรส่วนเกินต่อชิ้น = ราคา − วัตถุดิบ/บรรจุภัณฑ์ − ราคา × ต้นทุนผันแปรอื่น% */
export function unitContribution(price: number, unitCost: number, otherVariablePct: number): number {
  return price - unitCost - (price * otherVariablePct) / 100;
}

export interface MixRow {
  productId: string;
  name: string;
  qty: number;
  /** ราคาเฉลี่ยที่ขายจริงต่อชิ้น */
  price: number;
  /** วัตถุดิบ + บรรจุภัณฑ์ต่อชิ้น (null = ยังไม่มีสูตร) */
  unitCost: number | null;
}

export interface MixContribution {
  /** null = ไม่มีเมนูที่มีสูตรและมียอดขาย */
  avgContribution: number | null;
  avgPrice: number | null;
  avgUnitCost: number | null;
  coveredQty: number;
  totalQty: number;
  coveragePct: number;
  /** เมนูที่ขายแล้วขาดทุนตั้งแต่ก่อนหักต้นทุนคงที่ */
  negative: Array<{ productId: string; name: string; contribution: number }>;
}

/** กำไรส่วนเกินเฉลี่ยต่อชิ้น ถ่วงน้ำหนักตามจำนวนที่ขายจริง (เฉพาะเมนูที่มีสูตร) */
export function mixContribution(rows: MixRow[], otherVariablePct: number): MixContribution {
  let totalQty = 0;
  let coveredQty = 0;
  let sumContribution = 0;
  let sumPrice = 0;
  let sumCost = 0;
  const negative: MixContribution["negative"] = [];
  for (const row of rows) {
    if (!(row.qty > 0)) continue;
    totalQty += row.qty;
    if (row.unitCost === null) continue;
    const contribution = unitContribution(row.price, row.unitCost, otherVariablePct);
    coveredQty += row.qty;
    sumContribution += contribution * row.qty;
    sumPrice += row.price * row.qty;
    sumCost += row.unitCost * row.qty;
    if (contribution <= 0) negative.push({ productId: row.productId, name: row.name, contribution: roundTo(contribution) });
  }
  return {
    avgContribution: coveredQty > 0 ? roundTo(sumContribution / coveredQty) : null,
    avgPrice: coveredQty > 0 ? roundTo(sumPrice / coveredQty) : null,
    avgUnitCost: coveredQty > 0 ? roundTo(sumCost / coveredQty) : null,
    coveredQty,
    totalQty,
    coveragePct: totalQty > 0 ? Math.round((coveredQty / totalQty) * 1000) / 10 : 0,
    negative: negative.sort((a, b) => a.contribution - b.contribution),
  };
}

/** ความครอบคลุมขั้นต่ำก่อนแสดงตัวเลขคุ้มทุนแบบมั่นใจ */
export const MIN_COVERAGE_PCT = 50;

export interface BreakEvenResult {
  /** null = กำไรส่วนเกินต่อชิ้น ≤ 0 → ขายเท่าไรก็ไม่คุ้มทุน */
  monthUnits: number | null;
  dayUnits: number | null;
  targetMonthUnits: number | null;
  targetDayUnits: number | null;
}

/** จุดคุ้มทุน = ต้นทุนคงที่ ÷ กำไรส่วนเกินต่อชิ้น (ปัดขึ้นเป็นชิ้นเต็ม) */
export function breakEvenUnits(input: { fixedMonthly: number; contribution: number | null; targetProfitMonthly: number; openDaysPerMonth: number }): BreakEvenResult {
  const { fixedMonthly, contribution, targetProfitMonthly, openDaysPerMonth } = input;
  if (contribution === null || !(contribution > 0) || !(fixedMonthly >= 0)) {
    return { monthUnits: null, dayUnits: null, targetMonthUnits: null, targetDayUnits: null };
  }
  const ceil = (v: number) => Math.ceil(roundTo(v, 6));
  const month = fixedMonthly / contribution;
  const target = (fixedMonthly + Math.max(0, targetProfitMonthly)) / contribution;
  const days = openDaysPerMonth > 0 ? openDaysPerMonth : null;
  return {
    monthUnits: ceil(month),
    dayUnits: days ? ceil(month / days) : null,
    targetMonthUnits: ceil(target),
    targetDayUnits: days ? ceil(target / days) : null,
  };
}

/** ต้นทุนดำเนินการต่อชิ้น = ต้นทุนคงที่ ÷ จำนวนชิ้นต่อเดือน */
export function overheadPerUnit(fixedMonthly: number, unitsPerMonth: number): number | null {
  if (!(unitsPerMonth > 0) || !(fixedMonthly >= 0)) return null;
  return roundTo(fixedMonthly / unitsPerMonth);
}

/** ราคาที่ได้กำไรสุทธิ p% ของราคาขาย หลังหักต้นทุนทั้งหมด (วัตถุดิบ + ดำเนินการ + ผันแปรอื่น) */
export function priceForNetMargin(input: { fullUnitCost: number; netMarginPct: number; otherVariablePct: number; rounding: PriceRounding }): number | null {
  // ตัดเศษลอยจุด (1 − 0.7 − 0.3 ต้องเป็น 0 ไม่ใช่ 1e-16)
  const denominator = roundTo(1 - input.netMarginPct / 100 - input.otherVariablePct / 100, 6);
  if (!(denominator > 0) || !(input.fullUnitCost > 0)) return null;
  return roundPrice(input.fullUnitCost / denominator, input.rounding);
}

/** กำไรสุทธิต่อชิ้น และ % ของราคา ที่ราคาหนึ่ง */
export function netProfitAt(price: number, fullUnitCost: number, otherVariablePct: number): { perUnit: number; pct: number | null } {
  const perUnit = roundTo(price - fullUnitCost - (price * otherVariablePct) / 100);
  return { perUnit, pct: price > 0 ? Math.round((perUnit / price) * 1000) / 10 : null };
}

export const DEFAULT_MARGIN_STEPS = [10, 15, 20, 25, 30] as const;

export function priceLadder(input: {
  fullUnitCost: number;
  otherVariablePct: number;
  rounding: PriceRounding;
  steps?: readonly number[];
}): Array<{ marginPct: number; price: number; profitPerUnit: number }> {
  const steps = input.steps ?? DEFAULT_MARGIN_STEPS;
  return steps.flatMap((marginPct) => {
    const price = priceForNetMargin({ fullUnitCost: input.fullUnitCost, netMarginPct: marginPct, otherVariablePct: input.otherVariablePct, rounding: input.rounding });
    if (price === null) return [];
    return [{ marginPct, price, profitPerUnit: netProfitAt(price, input.fullUnitCost, input.otherVariablePct).perUnit }];
  });
}

/** กำไร/ขาดทุนต่อเดือนที่จำนวนชิ้นหนึ่ง */
export function monthlyProfit(unitsPerMonth: number, contribution: number, fixedMonthly: number): number {
  return roundTo(unitsPerMonth * contribution - fixedMonthly);
}

/** ระยะคืนทุน (เดือน) — null เมื่อยังไม่มีกำไรหรือไม่มีเงินลงทุน */
export function paybackMonths(startupTotal: number, profitPerMonth: number): number | null {
  if (!(startupTotal > 0) || !(profitPerMonth > 0)) return null;
  return Math.ceil(roundTo(startupTotal / profitPerMonth, 6));
}

/** วันต่อเดือนที่ใช้แปลงยอดช่วงปฏิทินเป็นยอดต่อเดือน */
export const DAYS_PER_MONTH = 30;

/**
 * จำนวนชิ้นต่อเดือนจากยอดจริง: ยอดในช่วง windowDays วันปฏิทิน → ต่อ 30 วัน · ต่อวัน = ต่อเดือน ÷ วันเปิดร้าน
 * (ไม่หารด้วย "วันที่มียอด" — ร้านเปิดไม่สม่ำเสมอจะได้ค่าเฉลี่ยสูงเกินจริง)
 */
export function actualUnitsPerMonth(totalQty: number, windowDays: number, openDaysPerMonth: number): { perDay: number; perMonth: number } | null {
  if (!(totalQty > 0) || !(windowDays > 0) || !(openDaysPerMonth > 0)) return null;
  const perMonth = (totalQty / windowDays) * DAYS_PER_MONTH;
  return { perDay: roundTo(perMonth / openDaysPerMonth, 1), perMonth: Math.round(perMonth) };
}

export interface ActualFixedCosts {
  /** รายจ่ายจริงเดือนก่อนตามประเภท (เฉพาะประเภทคงที่) */
  byType: Partial<Record<CostType, number>>;
  /** รายจ่ายในหมวดที่ยังไม่ได้ระบุประเภท */
  unmapped: number;
  payrollNet: number | null;
}

/** ค่าแรงนับซ้ำ: มีทั้งงบค่าแรง/หมวดบัญชีค่าแรง และเงินเดือนจากระบบเงินเดือน */
export function laborDoubleCountRisk(actual: ActualFixedCosts): boolean {
  return (actual.byType.labor ?? 0) > 0 && (actual.payrollNet ?? 0) > 0;
}

/** สรุปรายจ่ายรายการ (cost_type ของหมวด) เป็นยอดต่อประเภท — ประเภทผันแปรไม่นับ */
export function groupActualExpenses(rows: Array<{ amount: number; costType: string | null }>): Pick<ActualFixedCosts, "byType" | "unmapped"> {
  const byType: Partial<Record<CostType, number>> = {};
  let unmapped = 0;
  for (const row of rows) {
    if (!(row.amount > 0)) continue;
    if (!isCostType(row.costType)) {
      unmapped += row.amount;
      continue;
    }
    if (VARIABLE_COST_TYPES.includes(row.costType)) continue;
    byType[row.costType] = roundTo((byType[row.costType] ?? 0) + row.amount);
  }
  return { byType, unmapped: roundTo(unmapped) };
}

/** เดือนปฏิทินก่อนหน้าของวันที่ (YYYY-MM-DD, เวลาไทย) */
export function previousMonthRange(today: string): { from: string; to: string; label: string } {
  const [y, m] = today.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, "0")}`, label: `${mm}/${year}` };
}
