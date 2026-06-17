import { describe, expect, it } from "vitest";
import { addToCart, applyDiscount, emptyCart, removeFromCart, updateQuantity } from "@/modules/pos/cart";
import type { Cart } from "@/modules/pos/types";
import type { Product } from "@/modules/catalog/types";

function cart(overrides: Partial<Cart> = {}): Cart {
  return {
    storeId: "store-1",
    items: [
      {
        key: "p1",
        productId: "p1",
        productName: "ลาเต้",
        categoryId: "cat-1",
        variant: null,
        modifiers: [],
        quantity: 1,
        unitPrice: 100,
        totalPrice: 100,
      },
    ],
    subtotal: 100,
    discount: 0,
    total: 100,
    ...overrides,
  };
}

function product(): Product {
  return {
    id: "p1",
    storeId: "store-1",
    organizationId: "org-1",
    categoryId: "cat-1",
    name: "ลาเต้",
    description: undefined,
    basePrice: 100,
    imageUrl: undefined,
    isActive: true,
    availableForPos: true,
    availableForQr: true,
    sortOrder: 0,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    variants: [],
    modifierGroups: [],
  };
}

describe("applyDiscount", () => {
  it("caps discount at the current subtotal so persisted totals stay consistent", () => {
    const discounted = applyDiscount(cart(), 150, "เกินยอด");

    expect(discounted.discount).toBe(100);
    expect(discounted.total).toBe(0);
  });

  it("keeps negative discounts at zero", () => {
    const discounted = applyDiscount(cart(), -10);

    expect(discounted.discount).toBe(0);
    expect(discounted.total).toBe(100);
    expect(discounted.discountNote).toBeUndefined();
  });

  it("keeps non-finite discounts at zero", () => {
    const discounted = applyDiscount(cart(), Number.NaN, "parse error");

    expect(discounted.discount).toBe(0);
    expect(discounted.total).toBe(100);
    expect(discounted.discountNote).toBeUndefined();
  });

  it("keeps discount capped when item quantity reduces the subtotal", () => {
    const discounted = applyDiscount(cart({
      items: [
        {
          key: "p1",
          productId: "p1",
          productName: "ลาเต้",
          categoryId: "cat-1",
          variant: null,
          modifiers: [],
          quantity: 2,
          unitPrice: 100,
          totalPrice: 200,
        },
      ],
      subtotal: 200,
      total: 200,
    }), 200);

    const reduced = updateQuantity(discounted, "p1", 1);

    expect(reduced.subtotal).toBe(100);
    expect(reduced.discount).toBe(100);
    expect(reduced.total).toBe(0);
  });

  it("clears discount when removing the last discounted item", () => {
    const discounted = applyDiscount(cart(), 100, "เต็มยอด");

    const empty = removeFromCart(discounted, "p1");

    expect(empty.subtotal).toBe(0);
    expect(empty.discount).toBe(0);
    expect(empty.total).toBe(0);
    expect(empty.discountNote).toBeUndefined();
  });
});

describe("addToCart", () => {
  it("keeps the same product as separate line items when notes differ", () => {
    const base = emptyCart("store-1");
    const item = product();

    const first = addToCart(base, { product: item, variant: null, modifiers: [], note: "ไม่หวาน" });
    const second = addToCart(first, { product: item, variant: null, modifiers: [], note: "แยกน้ำแข็ง" });

    expect(second.items).toHaveLength(2);
    expect(second.items.map((line) => line.note)).toEqual(["ไม่หวาน", "แยกน้ำแข็ง"]);
    expect(second.items.map((line) => line.quantity)).toEqual([1, 1]);
    expect(second.subtotal).toBe(200);
  });
});
