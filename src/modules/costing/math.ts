/**
 * Store Cost Engine — สูตรคำนวณ (pure, ไม่มี I/O)
 * สูตรต้นทุนต่อจานต้องตรงกับ SQL costing_plate_cost() ใน migration 20261109000002 (parity test)
 */
import type { Ingredient, PriceRounding, RecipeLine } from "./types";

/** ปัดเศษเงินแบบไม่ลอยจุด (ทศนิยมสูงสุด digits ตำแหน่ง) */
export function roundTo(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** ต้นทุนวัตถุดิบต่อ 1 หน่วยที่ใช้จริง เช่น บาท/กรัม = ราคาซื้อ ÷ ปริมาณที่ใช้ได้ต่อการซื้อ ÷ (yield/100) */
export function ingredientUnitCost(ingredient: Pick<Ingredient, "purchasePrice" | "usagePerPurchase" | "yieldPct">): number {
  if (!(ingredient.usagePerPurchase > 0) || !(ingredient.yieldPct > 0)) return 0;
  return ingredient.purchasePrice / ingredient.usagePerPurchase / (ingredient.yieldPct / 100);
}

/** บรรทัดสูตรที่ใช้กับตัวเลือกนี้: บรรทัดที่ไม่ระบุตัวเลือก + บรรทัดของตัวเลือกนั้น */
export function recipeLinesFor(lines: RecipeLine[], productId: string, variantId: string | null): RecipeLine[] {
  return lines.filter((line) => line.productId === productId && (line.variantId === null || line.variantId === variantId));
}

/**
 * ต้นทุนวัตถุดิบต่อจาน — null เมื่อเมนูนี้ยังไม่มีสูตร (ห้ามนับเป็น 0 ในรายงาน)
 * ปัด 4 ตำแหน่งให้ตรงกับคอลัมน์ order_item_costs.unit_cost
 */
export function plateIngredientCost(
  lines: RecipeLine[],
  ingredientsById: Map<string, Pick<Ingredient, "purchasePrice" | "usagePerPurchase" | "yieldPct">>,
  productId: string,
  variantId: string | null,
): number | null {
  const used = recipeLinesFor(lines, productId, variantId);
  if (used.length === 0) return null;
  let total = 0;
  for (const line of used) {
    const ingredient = ingredientsById.get(line.ingredientId);
    if (!ingredient) continue;
    total += line.quantity * ingredientUnitCost(ingredient);
  }
  return roundTo(total, 4);
}

export function foodCostPct(plateCost: number, price: number): number | null {
  if (!(price > 0)) return null;
  return (plateCost / price) * 100;
}

/** ปัดราคาขึ้นตามกติกาของร้าน */
export function roundPrice(value: number, rule: PriceRounding): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  // ตัดเศษลอยจุดก่อนปัดขึ้น (เช่น 50.0000000001 ต้องเป็น 50 ไม่ใช่ 51)
  const clean = roundTo(value, 6);
  switch (rule) {
    case "none":
      return roundTo(clean, 2);
    case "ceil_1":
      return Math.ceil(clean);
    case "ceil_5":
      return Math.ceil(clean / 5) * 5;
    case "ceil_10":
      return Math.ceil(clean / 10) * 10;
  }
}

/** ราคาแนะนำจากเป้า food cost% (ต้นทุนรวมบรรจุภัณฑ์) */
export function suggestedPriceForFoodCost(plateCost: number, targetFoodCostPct: number, rule: PriceRounding): number | null {
  if (!(targetFoodCostPct > 0 && targetFoodCostPct < 100) || !(plateCost > 0)) return null;
  return roundPrice(plateCost / (targetFoodCostPct / 100), rule);
}

/** ราคาเดลิเวอรีที่ได้เงินเท่าหน้าร้านหลังหัก GP */
export function deliveryPriceForCommission(storePrice: number, commissionPct: number, rule: PriceRounding): number | null {
  if (!(storePrice > 0) || !(commissionPct >= 0 && commissionPct < 100)) return null;
  return roundPrice(storePrice / (1 - commissionPct / 100), rule);
}

export interface TargetsInput {
  fixedCostMonthly: number;
  /** ต้นทุนผันแปร % (food cost เฉลี่ย + อื่น ๆ) */
  variablePct: number;
  targetProfitMonthly: number;
  openDaysPerMonth: number;
  avgBill: number;
}

export interface TargetsResult {
  contribution: number;
  breakEvenMonth: number | null;
  targetMonth: number | null;
  targetDay: number | null;
  billsPerDay: number | null;
}

/** จุดคุ้มทุนและเป้า (7 ขั้นตอน) */
export function salesTargets(input: TargetsInput): TargetsResult {
  const contribution = 1 - input.variablePct / 100;
  if (!(contribution > 0)) {
    return { contribution, breakEvenMonth: null, targetMonth: null, targetDay: null, billsPerDay: null };
  }
  const breakEvenMonth = input.fixedCostMonthly / contribution;
  const targetMonth = (input.fixedCostMonthly + input.targetProfitMonthly) / contribution;
  const targetDay = input.openDaysPerMonth > 0 ? targetMonth / input.openDaysPerMonth : null;
  const billsPerDay = targetDay !== null && input.avgBill > 0 ? Math.ceil(roundTo(targetDay / input.avgBill, 6)) : null;
  return { contribution, breakEvenMonth, targetMonth, targetDay, billsPerDay };
}

/** ยอดขายเพิ่มขั้นต่ำที่ทำให้แคมเปญคุ้ม */
export function campaignMinSales(campaignCost: number, contribution: number): number | null {
  if (!(contribution > 0)) return null;
  return campaignCost / contribution;
}
