import type { Product, ProductUnit, ProductVariant } from "@/modules/catalog/types";
import { addToCart } from "@/modules/pos/cart";
import type { PriceTier } from "@/modules/pos/pricing";
import type { Cart } from "@/modules/pos/types";

export interface GroceryBarcodeMatch {
  product: Product;
  variant: ProductVariant | null;
  /** หน่วยแพ็ค (โหล/ลัง) เมื่อสแกนบาร์โค้ดของแพ็คหรือเลือกหน่วยจาก UI */
  unit?: ProductUnit | null;
  barcode: string;
}

export interface AddGroceryMatchOptions {
  quantity?: number;
  priceTier?: PriceTier;
}

export function addBarcodeMatchToGroceryCart(
  cart: Cart,
  match: GroceryBarcodeMatch,
  options: AddGroceryMatchOptions = {},
): Cart {
  return addToCart(cart, {
    product: match.product,
    variant: match.variant,
    unit: match.unit ?? null,
    priceTier: options.priceTier ?? "retail",
    modifiers: [],
    quantity: options.quantity ?? 1,
  });
}
