import type { Product, ProductUnit } from "@/modules/catalog/types";

/** ระดับราคาขายส่ง: ปลีก / ส่ง / ตัวแทน / ลูกค้าประจำ (null price = ใช้ราคาปลีก) */
export type PriceTier = "retail" | "wholesale" | "agent" | "regular";

export const PRICE_TIERS: PriceTier[] = ["retail", "wholesale", "agent", "regular"];

export const PRICE_TIER_LABELS: Record<PriceTier, string> = {
  retail: "ราคาปลีก",
  wholesale: "ราคาส่ง",
  agent: "ราคาตัวแทน",
  regular: "ลูกค้าประจำ",
};

export function normalizePriceTier(value: string | null | undefined): PriceTier {
  return value === "wholesale" || value === "agent" || value === "regular" ? value : "retail";
}

function pickTierPrice(
  tier: PriceTier,
  prices: { retail: number; wholesale?: number | null; agent?: number | null; regular?: number | null },
): number {
  const tierPrice =
    tier === "wholesale" ? prices.wholesale : tier === "agent" ? prices.agent : tier === "regular" ? prices.regular : null;
  return typeof tierPrice === "number" && Number.isFinite(tierPrice) ? tierPrice : prices.retail;
}

/** ราคาหน่วยฐาน (ชิ้น) ของสินค้า ตามระดับราคา — ยังไม่รวม variant/modifier adjustment */
export function resolveTierBasePrice(product: Product, tier: PriceTier): number {
  return pickTierPrice(tier, {
    retail: product.basePrice,
    wholesale: product.priceWholesale,
    agent: product.priceAgent,
    regular: product.priceRegular,
  });
}

/** ราคาต่อแพ็ค (โหล/ลัง) ตามระดับราคา — เป็นราคาเหมาต่อ 1 หน่วยแพ็ค */
export function resolveUnitTierPrice(unit: ProductUnit, tier: PriceTier): number {
  return pickTierPrice(tier, {
    retail: unit.price,
    wholesale: unit.priceWholesale,
    agent: unit.priceAgent,
    regular: unit.priceRegular,
  });
}
