import type { Cart, CartItem } from "./types";

type DiscountIntent = Pick<Cart, "discount" | "discountType" | "discountValue"> & {
  items?: Array<Pick<CartItem, "discount" | "discountType" | "discountValue">>;
};

function rawDiscountValue(
  source: Pick<CartItem, "discount" | "discountType" | "discountValue">,
): number | undefined {
  return source.discountType && typeof source.discountValue === "number"
    ? source.discountValue
    : source.discount;
}

function requestsDiscount(
  source: Pick<CartItem, "discount" | "discountType" | "discountValue">,
): boolean {
  const rawValue = rawDiscountValue(source);
  return Number.isFinite(rawValue) && Number(rawValue) > 0;
}

export function cartRequestsDiscount(
  cart: DiscountIntent,
): boolean {
  return requestsDiscount(cart) || (cart.items?.some((item) => requestsDiscount(item)) ?? false);
}
