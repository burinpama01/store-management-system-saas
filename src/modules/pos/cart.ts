import type { Cart, CartItem, CartItemKey, DiscountType, SelectedModifier } from "./types";
import { buildCartItemKey } from "./types";
import { resolveTierBasePrice, resolveUnitTierPrice, type PriceTier } from "./pricing";
import type { Product, ProductUnit, ProductVariant, ModifierOption } from "@/modules/catalog/types";

export interface AddToCartInput {
  product: Product;
  variant: ProductVariant | null;
  /** หน่วยขายแพ็ค (โหล/ลัง) — ราคาเหมาต่อหน่วย ไม่รวม modifier */
  unit?: ProductUnit | null;
  /** ระดับราคาลูกค้า (default ปลีก) */
  priceTier?: PriceTier;
  modifiers: { groupId: string; groupName: string; option: ModifierOption }[];
  quantity?: number;
  note?: string;
}

export interface ApplyOrderDiscountInput {
  type: DiscountType;
  value: number;
  note?: string;
}

export interface ApplyItemDiscountInput {
  type: DiscountType;
  value: number;
  note?: string;
}

export function emptyCart(storeId: string): Cart {
  return { storeId, items: [], subtotal: 0, discount: 0, total: 0 };
}

function computeUnitPrice(
  product: Product,
  variant: ProductVariant | null,
  unit: ProductUnit | null,
  tier: PriceTier,
): number {
  if (unit) return resolveUnitTierPrice(unit, tier);
  return resolveTierBasePrice(product, tier) + (variant?.priceAdjustment ?? 0);
}

function computeModifierPrice(modifiers: SelectedModifier[]): number {
  return modifiers.reduce((sum, m) => sum + m.option.priceAdjustment, 0);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeDiscountType(type: DiscountType | undefined): DiscountType {
  return type === "percentage" ? "percentage" : "amount";
}

function normalizeDiscountNote(note: string | undefined): string | undefined {
  return note?.trim().replace(/\s+/g, " ") || undefined;
}

function normalizeDiscountValue(type: DiscountType, value: number, subtotal: number): number {
  const rawValue = Number.isFinite(value) ? value : 0;
  const cappedValue =
    type === "percentage"
      ? Math.min(Math.max(0, rawValue), 100)
      : Math.min(Math.max(0, rawValue), subtotal);
  return roundMoney(cappedValue);
}

function computeDiscountAmount(type: DiscountType, value: number, subtotal: number): number {
  if (type === "percentage") {
    return roundMoney(Math.min(subtotal, subtotal * (value / 100)));
  }
  return roundMoney(Math.min(value, subtotal));
}

function recalcItemTotal(item: CartItem): CartItem {
  const lineSubtotal = roundMoney(item.unitPrice * item.quantity);
  const discountType = normalizeDiscountType(item.discountType);
  const rawDiscountValue =
    item.discountType && typeof item.discountValue === "number"
      ? item.discountValue
      : (item.discount ?? 0);
  const discountValue = normalizeDiscountValue(discountType, rawDiscountValue, lineSubtotal);
  const discount = computeDiscountAmount(discountType, discountValue, lineSubtotal);

  if (discount <= 0) {
    const cleanItem = { ...item };
    delete cleanItem.discount;
    delete cleanItem.discountType;
    delete cleanItem.discountValue;
    delete cleanItem.discountNote;
    return {
      ...cleanItem,
      totalPrice: lineSubtotal,
    };
  }

  return {
    ...item,
    totalPrice: roundMoney(lineSubtotal - discount),
    discount,
    discountType,
    discountValue,
    discountNote: normalizeDiscountNote(item.discountNote),
  };
}

function recalcTotals(cart: Cart): Cart {
  const items = cart.items.map(recalcItemTotal);
  const subtotal = roundMoney(items.reduce((s, i) => s + i.totalPrice, 0));
  const discountType = normalizeDiscountType(cart.discountType);
  const rawDiscountValue =
    cart.discountType && typeof cart.discountValue === "number" ? cart.discountValue : cart.discount;
  const discountValue = normalizeDiscountValue(discountType, rawDiscountValue, subtotal);
  const discount = computeDiscountAmount(discountType, discountValue, subtotal);
  const total = roundMoney(subtotal - discount);

  if (discount <= 0) {
    return {
      ...cart,
      items,
      subtotal,
      discount: 0,
      discountType: undefined,
      discountValue: undefined,
      discountNote: undefined,
      total,
    };
  }

  return {
    ...cart,
    items,
    subtotal,
    discount,
    discountType,
    discountValue,
    discountNote: normalizeDiscountNote(cart.discountNote),
    total,
  };
}

export function addToCart(cart: Cart, input: AddToCartInput): Cart {
  const note = input.note?.trim().replace(/\s+/g, " ") || undefined;
  const tier = input.priceTier ?? "retail";
  const unit = input.unit ?? null;
  // Pack units are all-inclusive prices — modifiers only apply to base-unit lines.
  const selectedModifiers: SelectedModifier[] = unit
    ? []
    : input.modifiers.map((m) => ({
        modifierGroupId: m.groupId,
        modifierGroupName: m.groupName,
        option: { id: m.option.id, name: m.option.name, priceAdjustment: m.option.priceAdjustment },
      }));

  const key = buildCartItemKey({
    productId: input.product.id,
    variantId: input.variant?.id ?? null,
    unitId: unit?.id ?? null,
    modifierOptionIds: selectedModifiers.map((m) => m.option.id),
    note,
  } satisfies CartItemKey);

  const unitPrice =
    computeUnitPrice(input.product, input.variant, unit, tier) + computeModifierPrice(selectedModifiers);
  const qty = input.quantity ?? 1;

  const existing = cart.items.find((i) => i.key === key);
  let items: CartItem[];
  if (existing) {
    const newQty = existing.quantity + qty;
    items = cart.items.map((i) =>
      i.key === key ? { ...i, quantity: newQty } : i,
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
      unit: unit ? { id: unit.id, name: unit.name, quantity: unit.quantity } : null,
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
  const items = cart.items.map((i) => (i.key === key ? { ...i, quantity } : i));
  return recalcTotals({ ...cart, items });
}

export function removeFromCart(cart: Cart, key: string): Cart {
  return recalcTotals({ ...cart, items: cart.items.filter((i) => i.key !== key) });
}

export function applyDiscount(cart: Cart, amount: number, note?: string): Cart {
  return applyOrderDiscount(cart, { type: "amount", value: amount, note });
}

export function applyOrderDiscount(cart: Cart, input: ApplyOrderDiscountInput): Cart {
  return recalcTotals({
    ...cart,
    discount: input.value,
    discountType: input.type,
    discountValue: input.value,
    discountNote: input.note,
  });
}

export function applyItemDiscount(
  cart: Cart,
  key: string,
  input: ApplyItemDiscountInput,
): Cart {
  return recalcTotals({
    ...cart,
    items: cart.items.map((item) =>
      item.key === key
        ? {
            ...item,
            discount: input.value,
            discountType: input.type,
            discountValue: input.value,
            discountNote: input.note,
          }
        : item,
    ),
  });
}

export function removeItemDiscount(cart: Cart, key: string): Cart {
  return recalcTotals({
    ...cart,
    items: cart.items.map((item) => {
      if (item.key !== key) return item;
      const cleanItem = { ...item };
      delete cleanItem.discount;
      delete cleanItem.discountType;
      delete cleanItem.discountValue;
      delete cleanItem.discountNote;
      return cleanItem;
    }),
  });
}

export function clearCart(cart: Cart): Cart {
  return emptyCart(cart.storeId);
}

/**
 * สร้างตะกร้าใหม่ด้วยราคาตามระดับลูกค้า (ใช้ตอนเลือก/เปลี่ยนลูกค้าใน POS ขายส่ง)
 * — รายการที่สินค้า/หน่วยหายไปจาก catalog จะถูกตัดออก, ส่วนลดเดิมถูกคงไว้
 */
export function repriceCartForTier(cart: Cart, products: Product[], tier: PriceTier): Cart {
  const productsById = new Map(products.map((product) => [product.id, product]));
  let next = emptyCart(cart.storeId);

  for (const item of cart.items) {
    const product = productsById.get(item.productId);
    if (!product) continue;

    const variant = item.variant
      ? product.variants.find((v) => v.id === item.variant?.id) ?? null
      : null;
    if (item.variant && !variant) continue;

    const unit = item.unit ? (product.units ?? []).find((u) => u.id === item.unit?.id) ?? null : null;
    if (item.unit && !unit) continue;

    const modifiers: AddToCartInput["modifiers"] = [];
    let missingModifier = false;
    for (const selected of item.modifiers) {
      const group = product.modifierGroups.find((g) => g.id === selected.modifierGroupId);
      const option = group?.options.find((o) => o.id === selected.option.id);
      if (!group || !option) {
        missingModifier = true;
        break;
      }
      modifiers.push({ groupId: group.id, groupName: group.name, option });
    }
    if (missingModifier) continue;

    next = addToCart(next, {
      product,
      variant,
      unit,
      priceTier: tier,
      modifiers,
      quantity: item.quantity,
      note: item.note,
    });

    if (item.discountType && typeof item.discountValue === "number") {
      const key = buildCartItemKey({
        productId: product.id,
        variantId: variant?.id ?? null,
        unitId: unit?.id ?? null,
        modifierOptionIds: modifiers.map((m) => m.option.id),
        note: item.note?.trim().replace(/\s+/g, " ") || undefined,
      });
      next = applyItemDiscount(next, key, {
        type: item.discountType,
        value: item.discountValue,
        note: item.discountNote,
      });
    }
  }

  if (cart.discountType && typeof cart.discountValue === "number") {
    next = applyOrderDiscount(next, {
      type: cart.discountType,
      value: cart.discountValue,
      note: cart.discountNote,
    });
  }

  return next;
}
