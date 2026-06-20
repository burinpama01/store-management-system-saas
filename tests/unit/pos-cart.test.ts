import { describe, expect, it } from "vitest";
import {
  addToCart,
  applyDiscount,
  applyItemDiscount,
  applyOrderDiscount,
  emptyCart,
  removeFromCart,
  removeItemDiscount,
  updateQuantity,
} from "@/modules/pos/cart";
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

  it("calculates percentage discounts from the current subtotal", () => {
    const discounted = applyOrderDiscount(
      cart({
        items: [{ ...cart().items[0], quantity: 2, totalPrice: 200 }],
        subtotal: 200,
        total: 200,
      }),
      { type: "percentage", value: 10, note: "สมาชิก" },
    );

    expect(discounted.discountType).toBe("percentage");
    expect(discounted.discountValue).toBe(10);
    expect(discounted.discount).toBe(20);
    expect(discounted.discountNote).toBe("สมาชิก");
    expect(discounted.total).toBe(180);
  });

  it("recomputes percentage discounts when the subtotal changes", () => {
    const discounted = applyOrderDiscount(
      cart({
        items: [{ ...cart().items[0], quantity: 2, totalPrice: 200 }],
        subtotal: 200,
        total: 200,
      }),
      { type: "percentage", value: 10 },
    );

    const reduced = updateQuantity(discounted, "p1", 1);

    expect(reduced.subtotal).toBe(100);
    expect(reduced.discountType).toBe("percentage");
    expect(reduced.discountValue).toBe(10);
    expect(reduced.discount).toBe(10);
    expect(reduced.total).toBe(90);
  });
});

describe("applyItemDiscount", () => {
  it("applies item percentage discounts before order discounts", () => {
    const itemDiscounted = applyItemDiscount(
      cart({
        items: [{ ...cart().items[0], quantity: 2, totalPrice: 200 }],
        subtotal: 200,
        total: 200,
      }),
      "p1",
      { type: "percentage", value: 10, note: "สมาชิก" },
    );

    const orderDiscounted = applyOrderDiscount(itemDiscounted, {
      type: "percentage",
      value: 10,
    });

    expect(orderDiscounted.items[0].discountType).toBe("percentage");
    expect(orderDiscounted.items[0].discountValue).toBe(10);
    expect(orderDiscounted.items[0].discount).toBe(20);
    expect(orderDiscounted.items[0].discountNote).toBe("สมาชิก");
    expect(orderDiscounted.items[0].totalPrice).toBe(180);
    expect(orderDiscounted.subtotal).toBe(180);
    expect(orderDiscounted.discount).toBe(18);
    expect(orderDiscounted.total).toBe(162);
  });

  it("recomputes item percentage discounts when quantity changes", () => {
    const discounted = applyItemDiscount(
      cart({
        items: [{ ...cart().items[0], quantity: 2, totalPrice: 200 }],
        subtotal: 200,
        total: 200,
      }),
      "p1",
      { type: "percentage", value: 10 },
    );

    const reduced = updateQuantity(discounted, "p1", 1);

    expect(reduced.items[0].discount).toBe(10);
    expect(reduced.items[0].totalPrice).toBe(90);
    expect(reduced.subtotal).toBe(90);
    expect(reduced.total).toBe(90);
  });

  it("clears item discount metadata without affecting the order discount draft", () => {
    const discounted = applyOrderDiscount(
      applyItemDiscount(cart(), "p1", { type: "amount", value: 25, note: "แก้วแตก" }),
      { type: "amount", value: 10, note: "ทั้งบิล" },
    );

    const cleared = removeItemDiscount(discounted, "p1");

    expect(cleared.items[0].discount).toBeUndefined();
    expect(cleared.items[0].discountType).toBeUndefined();
    expect(cleared.items[0].discountValue).toBeUndefined();
    expect(cleared.items[0].discountNote).toBeUndefined();
    expect(cleared.items[0].totalPrice).toBe(100);
    expect(cleared.subtotal).toBe(100);
    expect(cleared.discount).toBe(10);
    expect(cleared.discountNote).toBe("ทั้งบิล");
    expect(cleared.total).toBe(90);
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
