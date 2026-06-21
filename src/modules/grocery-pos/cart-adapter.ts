import type { Product, ProductVariant } from "@/modules/catalog/types";
import { addToCart } from "@/modules/pos/cart";
import type { Cart } from "@/modules/pos/types";

export interface GroceryBarcodeMatch {
  product: Product;
  variant: ProductVariant | null;
  barcode: string;
}

export function addBarcodeMatchToGroceryCart(cart: Cart, match: GroceryBarcodeMatch): Cart {
  return addToCart(cart, {
    product: match.product,
    variant: match.variant,
    modifiers: [],
    quantity: 1,
  });
}
