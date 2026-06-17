import type { Product, ProductVariant, ModifierOption } from "@/modules/catalog/types";
import type { Cart, CartItem, SelectedModifier } from "./types";
import { buildCartItemKey } from "./types";

export class CartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartValidationError";
  }
}

function assertMoney(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new CartValidationError(`${label} ไม่ถูกต้อง`);
  }
  return Math.round(value * 100) / 100;
}

function validateQuantity(quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new CartValidationError("จำนวนสินค้าไม่ถูกต้อง");
  }
  return quantity;
}

function normalizeNote(note: string | undefined): string | undefined {
  const normalized = note?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length <= 200 ? normalized : undefined;
}

function resolveVariant(
  product: Product,
  variantId: string | undefined,
): ProductVariant | null {
  if (product.variants.length === 0) {
    if (variantId) throw new CartValidationError("สินค้านี้ไม่มีตัวเลือกขนาด");
    return null;
  }
  if (!variantId) throw new CartValidationError("กรุณาเลือกขนาดสินค้า");
  const variant = product.variants.find((item) => item.id === variantId);
  if (!variant || !variant.isActive) {
    throw new CartValidationError("ตัวเลือกสินค้าไม่พร้อมใช้งาน");
  }
  return variant;
}

function addVariantStockDemand(
  requestedStockByVariant: Map<string, { requested: number; available: number }>,
  variant: ProductVariant | null,
  quantity: number,
) {
  if (
    !variant?.trackStock ||
    typeof variant.stockQuantity !== "number"
  ) {
    return;
  }

  const current = requestedStockByVariant.get(variant.id) ?? {
    requested: 0,
    available: variant.stockQuantity,
  };
  current.requested += quantity;
  requestedStockByVariant.set(variant.id, current);
  if (current.requested > current.available) {
    throw new CartValidationError("สินค้าเหลือไม่พอ");
  }
}

function resolveModifiers(product: Product, optionIds: string[]): SelectedModifier[] {
  const uniqueIds = new Set(optionIds);
  if (uniqueIds.size !== optionIds.length) {
    throw new CartValidationError("ตัวเลือกซ้ำในรายการสินค้า");
  }

  const selectedByGroup = new Map<string, ModifierOption[]>();
  for (const optionId of optionIds) {
    let matched:
      | { groupId: string; groupName: string; option: ModifierOption }
      | null = null;
    for (const group of product.modifierGroups) {
      const option = group.options.find((item) => item.id === optionId);
      if (option) matched = { groupId: group.id, groupName: group.name, option };
    }
    if (!matched || !matched.option.isActive) {
      throw new CartValidationError("ตัวเลือกเสริมไม่พร้อมใช้งาน");
    }
    const next = selectedByGroup.get(matched.groupId) ?? [];
    next.push(matched.option);
    selectedByGroup.set(matched.groupId, next);
  }

  const modifiers: SelectedModifier[] = [];
  for (const group of product.modifierGroups) {
    const selected = selectedByGroup.get(group.id) ?? [];
    const minSelections = group.isRequired ? Math.max(1, group.minSelections) : group.minSelections;
    if (selected.length < minSelections) {
      throw new CartValidationError(`กรุณาเลือก ${group.name}`);
    }
    if (selected.length > group.maxSelections) {
      throw new CartValidationError(`เลือก ${group.name} ได้ไม่เกิน ${group.maxSelections} รายการ`);
    }
    if (group.selectionType === "single" && selected.length > 1) {
      throw new CartValidationError(`${group.name} เลือกได้รายการเดียว`);
    }
    for (const option of selected) {
      modifiers.push({
        modifierGroupId: group.id,
        modifierGroupName: group.name,
        option: {
          id: option.id,
          name: option.name,
          priceAdjustment: option.priceAdjustment,
        },
      });
    }
  }
  return modifiers;
}

export function buildTrustedCartFromCatalog(
  clientCart: Cart,
  products: Product[],
  input: { storeId: string; canDiscount: boolean },
): Cart {
  if (clientCart.storeId !== input.storeId) {
    throw new CartValidationError("ร้านค้าในตะกร้าไม่ถูกต้อง");
  }

  const productsById = new Map(products.map((product) => [product.id, product]));
  const itemMap = new Map<string, CartItem>();
  const requestedStockByVariant = new Map<string, { requested: number; available: number }>();

  for (const clientItem of clientCart.items) {
    const product = productsById.get(clientItem.productId);
    if (!product || !product.isActive || !product.availableForPos) {
      throw new CartValidationError("สินค้าไม่พร้อมขายบน POS");
    }

    const quantity = validateQuantity(clientItem.quantity);
    const variant = resolveVariant(product, clientItem.variant?.id);
    addVariantStockDemand(requestedStockByVariant, variant, quantity);
    const modifierOptionIds = clientItem.modifiers.map((item) => item.option.id);
    const modifiers = resolveModifiers(product, modifierOptionIds);
    const unitPrice = assertMoney(
      product.basePrice +
        (variant?.priceAdjustment ?? 0) +
        modifiers.reduce((sum, item) => sum + item.option.priceAdjustment, 0),
      "ราคาสินค้า",
    );
    const note = normalizeNote(clientItem.note);
    const key = buildCartItemKey({
      productId: product.id,
      variantId: variant?.id ?? null,
      modifierOptionIds: modifiers.map((item) => item.option.id),
      note,
    });
    const existing = itemMap.get(key);
    if (existing) {
      const nextQty = validateQuantity(existing.quantity + quantity);
      itemMap.set(key, {
        ...existing,
        quantity: nextQty,
        totalPrice: assertMoney(existing.unitPrice * nextQty, "ยอดรวมสินค้า"),
      });
    } else {
      itemMap.set(key, {
        key,
        productId: product.id,
        productName: product.name,
        categoryId: product.categoryId,
        variant: variant
          ? {
              id: variant.id,
              name: variant.name,
              priceAdjustment: variant.priceAdjustment,
            }
          : null,
        modifiers,
        quantity,
        unitPrice,
        totalPrice: assertMoney(unitPrice * quantity, "ยอดรวมสินค้า"),
        note,
      });
    }
  }

  const items = Array.from(itemMap.values());
  const subtotal = assertMoney(items.reduce((sum, item) => sum + item.totalPrice, 0), "ยอดรวม");
  const discount = assertMoney(clientCart.discount, "ส่วนลด");
  if (discount > 0 && !input.canDiscount) {
    throw new CartValidationError("ไม่มีสิทธิ์ให้ส่วนลด");
  }
  if (discount > subtotal) {
    throw new CartValidationError("ส่วนลดมากกว่ายอดรวม");
  }
  const discountNote =
    clientCart.discountNote && clientCart.discountNote.length <= 200
      ? clientCart.discountNote
      : undefined;

  return {
    storeId: input.storeId,
    items,
    subtotal,
    discount,
    discountNote,
    total: assertMoney(subtotal - discount, "ยอดสุทธิ"),
  };
}
