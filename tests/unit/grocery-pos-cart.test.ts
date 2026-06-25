import { describe, expect, it } from "vitest";
import { addBarcodeMatchToGroceryCart } from "@/modules/grocery-pos/cart-adapter";
import { emptyCart } from "@/modules/pos/cart";
import type { Product, ProductVariant } from "@/modules/catalog/types";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "product-1",
    storeId: "store-1",
    organizationId: "org-1",
    categoryId: "cat-1",
    name: "น้ำดื่ม",
    description: undefined,
    barcode: "885000000001",
    basePrice: 10,
    imageUrl: undefined,
    isActive: true,
    availableForPos: true,
    availableForQr: false,
    sortOrder: 1,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    variants: [],
    modifierGroups: [],
    ...overrides,
  };
}

function variant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: "variant-1",
    productId: "product-1",
    name: "แพ็ค 6 ขวด",
    barcode: "885000000006",
    priceAdjustment: 45,
    sku: "WATER-6",
    stockQuantity: 12,
    trackStock: true,
    isActive: true,
    sortOrder: 1,
    ...overrides,
  };
}

describe("addBarcodeMatchToGroceryCart", () => {
  it("adds a product barcode match to an empty cart", () => {
    const cart = addBarcodeMatchToGroceryCart(emptyCart("store-1"), {
      product: product(),
      variant: null,
      barcode: "885000000001",
    });

    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].productName).toBe("น้ำดื่ม");
    expect(cart.items[0].quantity).toBe(1);
    expect(cart.total).toBe(10);
  });

  it("increments quantity when the same barcode is scanned again", () => {
    const first = addBarcodeMatchToGroceryCart(emptyCart("store-1"), {
      product: product(),
      variant: null,
      barcode: "885000000001",
    });
    const second = addBarcodeMatchToGroceryCart(first, {
      product: product(),
      variant: null,
      barcode: "885000000001",
    });

    expect(second.items).toHaveLength(1);
    expect(second.items[0].quantity).toBe(2);
    expect(second.total).toBe(20);
  });

  it("uses the variant barcode match when the barcode belongs to a variant", () => {
    const pack = variant();
    const cart = addBarcodeMatchToGroceryCart(emptyCart("store-1"), {
      product: product({ variants: [pack] }),
      variant: pack,
      barcode: "885000000006",
    });

    expect(cart.items[0].variant?.id).toBe("variant-1");
    expect(cart.items[0].unitPrice).toBe(55);
  });
});
