/**
 * การแบ่งสัดส่วนต้นทุนต่อหน่วย 5 ส่วน (v2 หัวข้อ 02, 07) — pure
 */
import { roundPrice, roundTo } from "./math";
import { COST_BUCKETS, type AllocationPcts, type AllocationTemplate, type CostBucket, type PriceRounding } from "./types";

export function allocationSum(pcts: AllocationPcts): number {
  return roundTo(COST_BUCKETS.reduce((sum, bucket) => sum + (pcts[bucket] ?? 0), 0), 2);
}

/** ตรวจสัดส่วนก่อนบันทึก — คืนข้อความภาษาไทยเมื่อผิด */
export function validateAllocation(pcts: AllocationPcts): string | null {
  for (const bucket of COST_BUCKETS) {
    const value = pcts[bucket];
    if (!Number.isFinite(value) || value < 0 || value > 100) return "สัดส่วนแต่ละส่วนต้องอยู่ระหว่าง 0–100%";
    if (roundTo(value, 2) !== value) return "สัดส่วนใส่ทศนิยมได้ไม่เกิน 2 ตำแหน่ง";
  }
  const sum = allocationSum(pcts);
  if (sum !== 100) return `สัดส่วนรวมต้องเท่ากับ 100% (ตอนนี้ ${sum}%)`;
  return null;
}

/**
 * template ที่มีผล ณ เวลาหนึ่ง: ใช้ของเมนูก่อน ถ้าไม่มีใช้ของร้าน
 * (effective_from ล่าสุดที่ไม่เกินเวลานั้น)
 */
export function effectiveAllocation(
  templates: AllocationTemplate[],
  productId: string | null,
  at: Date = new Date(),
): AllocationTemplate | null {
  const atMs = at.getTime();
  const pick = (scope: string | null) =>
    templates
      .filter((t) => t.productId === scope && new Date(t.effectiveFrom).getTime() <= atMs)
      .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime())[0] ?? null;
  const productRow = productId ? pick(productId) : null;
  // แถว use_store_default = เมนูนี้กลับไปใช้ค่าร้านตั้งแต่เวลานั้น
  if (productRow && !productRow.useStoreDefault) return productRow;
  return pick(null);
}

export interface BucketLine {
  bucket: CostBucket;
  targetPct: number;
  targetAmount: number;
  actualAmount: number;
  actualPct: number;
  /** ไม่ถึงเป้า: ต้นทุนเกินเป้า หรือ กำไรต่ำกว่าเป้า */
  offTarget: boolean;
}

export interface MenuAllocationCard {
  price: number;
  lines: BucketLine[];
  /** ราคาที่ทำให้กำไรกลับไปตามเป้า (null = คำนวณไม่ได้ เช่น ยังไม่มีสูตร) */
  priceForTarget: number | null;
  hasRecipe: boolean;
}

/**
 * การ์ดต่อเมนู: วัตถุดิบ/บรรจุภัณฑ์ใช้ค่าจริงจากสูตร · ค่าแรง/ค่าใช้จ่ายร้านใช้ % ของราคาตามเป้า
 * กำไร = ราคา − อีก 4 ส่วน · ราคาแนะนำ = (วัตถุดิบ + บรรจุภัณฑ์) ÷ (1 − (แรง+ร้าน+กำไร)%)
 */
export function menuAllocationCard(input: {
  price: number;
  ingredientCost: number | null;
  packagingCost: number;
  pcts: AllocationPcts;
  rounding: PriceRounding;
}): MenuAllocationCard {
  const { price, pcts } = input;
  const ingredient = input.ingredientCost ?? 0;
  const packaging = input.packagingCost;
  const labor = (price * pcts.labor) / 100;
  const overhead = (price * pcts.overhead) / 100;
  const profit = price - ingredient - packaging - labor - overhead;
  const actual: Record<CostBucket, number> = { ingredient, packaging, labor, overhead, profit };
  const lines = COST_BUCKETS.map((bucket) => {
    const targetAmount = (price * pcts[bucket]) / 100;
    const actualAmount = actual[bucket];
    const offTarget =
      bucket === "profit" ? actualAmount < targetAmount - 0.005 : bucket === "ingredient" || bucket === "packaging" ? actualAmount > targetAmount + 0.005 : false;
    return {
      bucket,
      targetPct: pcts[bucket],
      targetAmount: roundTo(targetAmount, 2),
      actualAmount: roundTo(actualAmount, 2),
      actualPct: price > 0 ? roundTo((actualAmount / price) * 100, 1) : 0,
      offTarget,
    };
  });
  const denominator = 1 - (pcts.labor + pcts.overhead + pcts.profit) / 100;
  const hasRecipe = input.ingredientCost !== null;
  const directCost = ingredient + packaging;
  const priceForTarget = hasRecipe && denominator > 0 && directCost > 0 ? roundPrice(directCost / denominator, input.rounding) : null;
  return { price, lines, priceForTarget, hasRecipe };
}
