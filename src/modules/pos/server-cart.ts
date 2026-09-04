import type { Product, ProductUnit, ProductVariant, ModifierOption } from "@/modules/catalog/types";
import type { Cart, CartItem, DiscountType, SelectedModifier } from "./types";
import { buildCartItemKey } from "./types";
import { resolveTierBasePrice, resolveUnitTierPrice, type PriceTier } from "./pricing";

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

// Wholesale bills routinely carry hundreds of pieces per line — cap generously.
const MAX_LINE_QUANTITY = 9999;

function validateQuantity(quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    throw new CartValidationError("จำนวนสินค้าไม่ถูกต้อง");
  }
  return quantity;
}

function normalizeNote(note: string | undefined): string | undefined {
  const normalized = note?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  return normalized.length <= 200 ? normalized : undefined;
}

function normalizeDiscountType(type: DiscountType | undefined): DiscountType {
  if (type === undefined || type === "amount") return "amount";
  if (type === "percentage") return "percentage";
  throw new CartValidationError("ประเภทส่วนลดไม่ถูกต้อง");
}

function rawDiscountValue(
  source: Pick<CartItem, "discount" | "discountType" | "discountValue">,
): number {
  return source.discountType && typeof source.discountValue === "number"
    ? source.discountValue
    : (source.discount ?? 0);
}

function buildTrustedDiscount(
  clientCart: Cart,
  subtotal: number,
): { discount: number; discountType?: DiscountType; discountValue?: number } {
  const discountType = normalizeDiscountType(clientCart.discountType);
  const rawValue = rawDiscountValue(clientCart);
  const discountValue = assertMoney(rawValue, discountType === "percentage" ? "เปอร์เซ็นต์ส่วนลด" : "ส่วนลด");

  if (discountType === "percentage") {
    if (discountValue > 100) {
      throw new CartValidationError("เปอร์เซ็นต์ส่วนลดต้องอยู่ระหว่าง 0-100");
    }
    const discount = assertMoney(Math.min(subtotal, subtotal * (discountValue / 100)), "ส่วนลด");
    return discount > 0 ? { discount, discountType, discountValue } : { discount: 0 };
  }

  if (discountValue > subtotal) {
    throw new CartValidationError("ส่วนลดมากกว่ายอดรวม");
  }
  return discountValue > 0
    ? { discount: discountValue, discountType, discountValue }
    : { discount: 0 };
}

function buildTrustedItemDiscount(
  clientItem: CartItem,
  lineSubtotal: number,
): { discount: number; discountType?: DiscountType; discountValue?: number; discountNote?: string } {
  const discountType = normalizeDiscountType(clientItem.discountType);
  const rawValue = rawDiscountValue(clientItem);
  const discountValue = assertMoney(
    rawValue,
    discountType === "percentage" ? "เปอร์เซ็นต์ส่วนลดรายการ" : "ส่วนลดรายการ",
  );

  if (discountType === "percentage") {
    if (discountValue > 100) {
      throw new CartValidationError("เปอร์เซ็นต์ส่วนลดรายการต้องอยู่ระหว่าง 0-100");
    }
    const discount = assertMoney(Math.min(lineSubtotal, lineSubtotal * (discountValue / 100)), "ส่วนลดรายการ");
    return discount > 0
      ? {
          discount,
          discountType,
          discountValue,
          discountNote: normalizeNote(clientItem.discountNote),
        }
      : { discount: 0 };
  }

  if (discountValue > lineSubtotal) {
    throw new CartValidationError("ส่วนลดรายการมากกว่ายอดรวมสินค้า");
  }
  return discountValue > 0
    ? {
        discount: discountValue,
        discountType,
        discountValue,
        discountNote: normalizeNote(clientItem.discountNote),
      }
    : { discount: 0 };
}

function applyTrustedItemDiscount(item: CartItem): CartItem {
  const lineSubtotal = assertMoney(item.unitPrice * item.quantity, "ยอดรวมสินค้า");
  const trustedDiscount = buildTrustedItemDiscount(item, lineSubtotal);
  const cleanItem: CartItem = {
    key: item.key,
    productId: item.productId,
    productName: item.productName,
    categoryId: item.categoryId,
    variant: item.variant,
    unit: item.unit ?? null,
    modifiers: item.modifiers,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalPrice: assertMoney(lineSubtotal - trustedDiscount.discount, "ยอดรวมสินค้า"),
    note: item.note,
  };

  if (trustedDiscount.discount <= 0) {
    return cleanItem;
  }

  return {
    ...cleanItem,
    discount: trustedDiscount.discount,
    discountType: trustedDiscount.discountType,
    discountValue: trustedDiscount.discountValue,
    discountNote: trustedDiscount.discountNote,
  };
}

function sameItemDiscount(a: CartItem, b: CartItem): boolean {
  return (
    (a.discountType ?? "amount") === (b.discountType ?? "amount") &&
    (a.discountValue ?? 0) === (b.discountValue ?? 0) &&
    (a.discountNote ?? "") === (b.discountNote ?? "")
  );
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

function resolveUnit(product: Product, unitId: string | null | undefined): ProductUnit | null {
  if (!unitId) return null;
  const unit = (product.units ?? []).find((item) => item.id === unitId);
  if (!unit || !unit.isActive) {
    throw new CartValidationError("หน่วยขายนี้ไม่พร้อมใช้งาน");
  }
  return unit;
}

/**
 * variant ที่ผูก Stock Pool ใช้ยอดของ Pool เป็นเกณฑ์ (Pool = แหล่งความจริงเดียว —
 * RPC ก็ไม่ตัด product_variants.stock_quantity ให้รายการเหล่านี้) หลาย variant
 * แชร์ Pool เดียวกันได้ จึงรวมความต้องการที่ระดับ "Pool" ไม่ใช่ระดับ variant
 */
function addVariantStockDemand(
  requestedStockByVariant: Map<string, { requested: number; available: number }>,
  variant: ProductVariant | null,
  quantity: number,
) {
  if (!variant) return;

  const pool = variant.stockPool;
  if (pool) {
    const current = requestedStockByVariant.get(`pool:${pool.poolId}`) ?? {
      requested: 0,
      available: pool.quantity,
    };
    current.requested += quantity * pool.consumptionQuantity;
    requestedStockByVariant.set(`pool:${pool.poolId}`, current);
    if (current.requested > current.available) {
      throw new CartValidationError(`สต๊อก ${pool.poolName} เหลือไม่พอ`);
    }
    return;
  }

  if (!variant.trackStock || typeof variant.stockQuantity !== "number") {
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
  input: { storeId: string; canDiscount: boolean; priceTier?: PriceTier },
): Cart {
  if (clientCart.storeId !== input.storeId) {
    throw new CartValidationError("ร้านค้าในตะกร้าไม่ถูกต้อง");
  }

  const priceTier = input.priceTier ?? "retail";
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
    const unit = resolveUnit(product, clientItem.unit?.id);
    // Pack lines consume base-unit stock: quantity × pack size.
    addVariantStockDemand(requestedStockByVariant, variant, quantity * (unit?.quantity ?? 1));
    if (unit && clientItem.modifiers.length > 0) {
      throw new CartValidationError("หน่วยขายแพ็คใช้ร่วมกับตัวเลือกเสริมไม่ได้");
    }
    const modifierOptionIds = clientItem.modifiers.map((item) => item.option.id);
    const modifiers = unit ? [] : resolveModifiers(product, modifierOptionIds);
    const unitPrice = assertMoney(
      unit
        ? resolveUnitTierPrice(unit, priceTier)
        : resolveTierBasePrice(product, priceTier) +
            (variant?.priceAdjustment ?? 0) +
            modifiers.reduce((sum, item) => sum + item.option.priceAdjustment, 0),
      "ราคาสินค้า",
    );
    const note = normalizeNote(clientItem.note);
    const key = buildCartItemKey({
      productId: product.id,
      variantId: variant?.id ?? null,
      unitId: unit?.id ?? null,
      modifierOptionIds: modifiers.map((item) => item.option.id),
      note,
    });
    const existing = itemMap.get(key);
    if (existing) {
      const lineSubtotal = assertMoney(unitPrice * quantity, "ยอดรวมสินค้า");
      const trustedItem = applyTrustedItemDiscount({
        ...existing,
        quantity,
        totalPrice: lineSubtotal,
        discount: clientItem.discount,
        discountType: clientItem.discountType,
        discountValue: clientItem.discountValue,
        discountNote: clientItem.discountNote,
      });
      if (trustedItem.discount && !input.canDiscount) {
        throw new CartValidationError("ไม่มีสิทธิ์ให้ส่วนลด");
      }
      if (!sameItemDiscount(existing, trustedItem)) {
        throw new CartValidationError("ส่วนลดรายการซ้ำไม่ตรงกัน");
      }
      const nextQty = validateQuantity(existing.quantity + quantity);
      itemMap.set(key, applyTrustedItemDiscount({
        ...existing,
        quantity: nextQty,
        totalPrice: assertMoney(existing.unitPrice * nextQty, "ยอดรวมสินค้า"),
      }));
    } else {
      const lineSubtotal = assertMoney(unitPrice * quantity, "ยอดรวมสินค้า");
      const trustedItem = applyTrustedItemDiscount({
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
        unit: unit ? { id: unit.id, name: unit.name, quantity: unit.quantity } : null,
        modifiers,
        quantity,
        unitPrice,
        totalPrice: lineSubtotal,
        discount: clientItem.discount,
        discountType: clientItem.discountType,
        discountValue: clientItem.discountValue,
        discountNote: clientItem.discountNote,
        note,
      });
      if (trustedItem.discount && !input.canDiscount) {
        throw new CartValidationError("ไม่มีสิทธิ์ให้ส่วนลด");
      }
      itemMap.set(key, trustedItem);
    }
  }

  const items = Array.from(itemMap.values());
  const subtotal = assertMoney(items.reduce((sum, item) => sum + item.totalPrice, 0), "ยอดรวม");
  const trustedDiscount = buildTrustedDiscount(clientCart, subtotal);
  const { discount } = trustedDiscount;
  if (discount > 0 && !input.canDiscount) {
    throw new CartValidationError("ไม่มีสิทธิ์ให้ส่วนลด");
  }
  const discountNote = discount > 0 ? normalizeNote(clientCart.discountNote) : undefined;

  return {
    storeId: input.storeId,
    items,
    subtotal,
    discount,
    discountType: trustedDiscount.discountType,
    discountValue: trustedDiscount.discountValue,
    discountNote,
    total: assertMoney(subtotal - discount, "ยอดสุทธิ"),
  };
}
