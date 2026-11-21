/**
 * คลังวัตถุดิบ — สูตรล้วน (เทสต์ได้, ใช้ซ้ำในเฟส A1–A5)
 * หน่วยในคลัง = หน่วยใช้ของวัตถุดิบ (กรัม/มล./ชิ้น)
 */
import type { StockStatus } from "./types";

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
};

export const roundQty = (value: number) => round(value, 4);
export const roundUnitCost = (value: number) => round(value, 6);

/** จำนวนหน่วยซื้อ → หน่วยใช้ (เช่น 3 กก. × 1000 = 3000 กรัม) */
export function toUsageUnits(purchaseUnits: number, usagePerPurchase: number): number {
  if (!(usagePerPurchase > 0)) throw new Error("usagePerPurchase must be > 0");
  return roundQty(purchaseUnits * usagePerPurchase);
}

/** หน่วยใช้ → หน่วยซื้อ (แสดงผล เช่น 2500 กรัม = 2.5 กก.) */
export function toPurchaseUnits(usageUnits: number, usagePerPurchase: number): number {
  if (!(usagePerPurchase > 0)) throw new Error("usagePerPurchase must be > 0");
  return roundQty(usageUnits / usagePerPurchase);
}

/** ราคาซื้อต่อหน่วยซื้อ → ต้นทุนต่อหน่วยใช้ (ยังไม่หัก yield — yield ใช้ตอนคิดสูตร) */
export function unitCostFromPurchasePrice(purchasePrice: number, usagePerPurchase: number): number {
  if (!(usagePerPurchase > 0)) throw new Error("usagePerPurchase must be > 0");
  return roundUnitCost(purchasePrice / usagePerPurchase);
}

/**
 * ต้นทุนเฉลี่ยถ่วงน้ำหนักหลังรับเข้า
 * ยอดเดิมติดลบหรือศูนย์ → ใช้ราคารับเข้าครั้งนี้ (กันค่าเพี้ยนจากยอดติดลบ)
 */
export function weightedAverageCost(input: {
  onHand: number;
  avgUnitCost: number;
  qtyIn: number;
  unitCostIn: number;
}): number {
  const { onHand, avgUnitCost, qtyIn, unitCostIn } = input;
  if (!(qtyIn > 0)) return roundUnitCost(avgUnitCost);
  const base = Math.max(onHand, 0);
  if (base === 0) return roundUnitCost(unitCostIn);
  return roundUnitCost((base * avgUnitCost + qtyIn * unitCostIn) / (base + qtyIn));
}

/** จุดสั่งซื้อแนะนำ = ใช้เฉลี่ยต่อวัน × (วันรอของ + วันสำรอง) */
export function suggestedReorderPoint(avgDailyUsage: number, leadDays: number, safetyDays: number): number {
  if (!(avgDailyUsage > 0)) return 0;
  return roundQty(avgDailyUsage * (Math.max(leadDays, 0) + Math.max(safetyDays, 0)));
}

export function stockStatus(onHand: number | null, reorderPoint: number | null): StockStatus {
  if (onHand === null) return "unset";
  if (onHand < 0) return "negative";
  if (onHand === 0) return "out";
  if (reorderPoint !== null && onHand <= reorderPoint) return "low";
  return "ok";
}

export function stockValue(onHand: number | null, avgUnitCost: number | null): number {
  if (onHand === null || avgUnitCost === null || onHand <= 0) return 0;
  return round(onHand * avgUnitCost, 2);
}
