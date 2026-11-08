/** Store Cost Engine — ชนิดข้อมูล (Plan/Store Cost Engine Plan v3.html) */

export type PriceRounding = "none" | "ceil_1" | "ceil_5" | "ceil_10";

export const COST_BUCKETS = ["ingredient", "packaging", "labor", "overhead", "profit"] as const;
export type CostBucket = (typeof COST_BUCKETS)[number];

export const COST_BUCKET_LABELS: Record<CostBucket, string> = {
  ingredient: "วัตถุดิบ",
  packaging: "บรรจุภัณฑ์",
  labor: "ค่าแรง",
  overhead: "ค่าใช้จ่ายร้าน",
  profit: "กำไรสุทธิ",
};

export interface Ingredient {
  id: string;
  storeId: string;
  name: string;
  purchaseUnit: string;
  usageUnit: string;
  usagePerPurchase: number;
  purchasePrice: number;
  yieldPct: number;
  isActive: boolean;
}

export interface IngredientInput {
  id?: string | null;
  name: string;
  purchaseUnit: string;
  usageUnit: string;
  usagePerPurchase: number;
  purchasePrice: number;
  yieldPct: number;
}

export interface RecipeLine {
  id: string;
  productId: string;
  /** null = ใช้กับทุกตัวเลือกของเมนู */
  variantId: string | null;
  ingredientId: string;
  quantity: number;
}

export interface ProductCostSetting {
  productId: string;
  packagingCost: number;
  /** null = ใช้เป้าของร้าน */
  targetFoodCostPct: number | null;
}

export interface StoreCostSettings {
  openDaysPerMonth: number;
  targetProfitMonthly: number;
  targetFoodCostPct: number;
  otherVariablePct: number;
  priceRounding: PriceRounding;
  cashReserve: number | null;
}

export const DEFAULT_STORE_COST_SETTINGS: StoreCostSettings = {
  openDaysPerMonth: 26,
  targetProfitMonthly: 0,
  targetFoodCostPct: 35,
  otherVariablePct: 0,
  priceRounding: "ceil_1",
  cashReserve: null,
};

/** สัดส่วนเป้าหมาย 5 ส่วน (รวม 100) */
export type AllocationPcts = Record<CostBucket, number>;

export const DEFAULT_ALLOCATION: AllocationPcts = {
  ingredient: 30,
  packaging: 10,
  labor: 10,
  overhead: 15,
  profit: 35,
};

export interface AllocationTemplate {
  id: string;
  /** null = ค่าทั้งร้าน */
  productId: string | null;
  pcts: AllocationPcts;
  effectiveFrom: string;
}
