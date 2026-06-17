import type { Cart, CartItem, CartItemKey, SelectedModifier } from "./types";
import { buildCartItemKey } from "./types";
import type { Product, ProductVariant, ModifierOption } from "@/modules/catalog/types";

export interface AddToCartInput {
  product: Product;
  variant: ProductVariant | null;
  modifiers: { groupId: string; groupName: string; option: ModifierOption }[];
  quantity?: number;
  note?: string;
}

export function emptyCart(storeId: string): Cart {
  return { storeId, items: [], subtotal: 0, discount: 0, total: 0 };
}

function computeUnitPrice(product: Product, variant: ProductVariant | null): number {
  return product.basePrice + (variant?.priceAdjustment ?? 0);
}

function computeModifierPrice(modifiers: SelectedModifier[]): number {
  return modifiers.reduce((sum, m) => sum + m.option.priceAdjustment, 0);
}

function recalcTotals(cart: Cart): Cart {
  const subtotal = cart.items.reduce((s, i) => s + i.totalPrice, 0);
  const rawDiscount = Number.isFinite(cart.discount) ? cart.discount : 0;
  const discount = Math.min(Math.max(0, rawDiscount), subtotal);
  const total = subtotal - discount;
  return {
    ...cart,
    subtotal,
    discount,
    discountNote: discount > 0 ? cart.discountNote : undefined,
    total,
  };
}

export function addToCart(cart: Cart, input: AddToCartInput): Cart {
  const note = input.note?.trim().replace(/\s+/g, " ") || undefined;
  const selectedModifiers: SelectedModifier[] = input.modifiers.map((m) => ({
    modifierGroupId: m.groupId,
    modifierGroupName: m.groupName,
    option: { id: m.option.id, name: m.option.name, priceAdjustment: m.option.priceAdjustment },
  }));

  const key = buildCartItemKey({
    productId: input.product.id,
    variantId: input.variant?.id ?? null,
    modifierOptionIds: selectedModifiers.map((m) => m.option.id),
    note,
  } satisfies CartItemKey);

  const unitPrice =
    computeUnitPrice(input.product, input.variant) + computeModifierPrice(selectedModifiers);
  const qty = input.quantity ?? 1;

  const existing = cart.items.find((i) => i.key === key);
  let items: CartItem[];
  if (existing) {
    const newQty = existing.quantity + qty;
    items = cart.items.map((i) =>
      i.key === key ? { ...i, quantity: newQty, totalPrice: i.unitPrice * newQty } : i,
    );
  } else {
    const newItem: CartItem = {
      key,
      productId: input.product.id,
      productName: input.product.name,
      categoryId: input.product.categoryId,
      variant: input.variant
        ? {
            id: input.variant.id,
            name: input.variant.name,
            priceAdjustment: input.variant.priceAdjustment,
          }
        : null,
      modifiers: selectedModifiers,
      quantity: qty,
      unitPrice,
      totalPrice: unitPrice * qty,
      note,
    };
    items = [...cart.items, newItem];
  }

  return recalcTotals({ ...cart, items });
}

export function updateQuantity(cart: Cart, key: string, quantity: number): Cart {
  if (quantity <= 0) return removeFromCart(cart, key);
  const items = cart.items.map((i) =>
    i.key === key ? { ...i, quantity, totalPrice: i.unitPrice * quantity } : i,
  );
  return recalcTotals({ ...cart, items });
}

export function removeFromCart(cart: Cart, key: string): Cart {
  return recalcTotals({ ...cart, items: cart.items.filter((i) => i.key !== key) });
}

export function applyDiscount(cart: Cart, amount: number, note?: string): Cart {
  return recalcTotals({ ...cart, discount: amount, discountNote: note });
}

export function clearCart(cart: Cart): Cart {
  return emptyCart(cart.storeId);
}
