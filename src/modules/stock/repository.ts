import { listProducts } from "@/modules/catalog/repository";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Product } from "@/modules/catalog/types";
import type { StockAlert } from "./types";

export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/**
 * Sets a variant's tracked stock quantity (and enables tracking). Validates the
 * variant belongs to the caller's store. Use from a stock.manage server action.
 */
export async function setVariantStock(variantId: string, storeId: string, quantity: number) {
  const supabase = await createSupabaseServerClient();
  const { data: variant } = await supabase
    .from("product_variants")
    .select("product_id")
    .eq("id", variantId)
    .single();
  if (!variant) return { ok: false, error: mapError(new Error("ไม่พบตัวเลือกสินค้า")) };

  const { data: product } = await supabase
    .from("products")
    .select("store_id")
    .eq("id", variant.product_id)
    .single();
  if (!product || product.store_id !== storeId) {
    return { ok: false, error: mapError(new Error("ไม่มีสิทธิ์")) };
  }

  const { error } = await supabase
    .from("product_variants")
    .update({ stock_quantity: Math.max(0, Math.round(quantity)), track_stock: true })
    .eq("id", variantId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

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
