import { listProducts } from "@/modules/catalog/repository";
import type { Product } from "@/modules/catalog/types";
import type { StockAlert } from "./types";

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export function computeStockAlerts(
  products: Product[],
  threshold = DEFAULT_LOW_STOCK_THRESHOLD,
): StockAlert[] {
  return products.flatMap((product) =>
    product.variants
      .filter(
        (variant) =>
          variant.isActive &&
          variant.trackStock &&
          typeof variant.stockQuantity === "number" &&
          variant.stockQuantity <= threshold,
      )
      .map((variant) => ({
        productId: product.id,
        variantId: variant.id,
        productName: product.name,
        variantName: variant.name,
        stockQuantity: variant.stockQuantity as number,
        threshold,
        severity:
          (variant.stockQuantity as number) <= 0 ? "out" as const : "low" as const,
      })),
  ).sort((a, b) => a.stockQuantity - b.stockQuantity);
}

export async function listLowStockAlerts(
  storeId: string,
  threshold = DEFAULT_LOW_STOCK_THRESHOLD,
) {
  const productsRes = await listProducts(storeId, { includeInactive: false });
  if (productsRes.error || !productsRes.data) {
    return { data: null, error: productsRes.error };
  }
  return {
    data: computeStockAlerts(productsRes.data, threshold),
    error: null,
  };
}
