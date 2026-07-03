import { describe, expect, it } from "vitest";
import { addToCart, repriceCartForTier, emptyCart } from "@/modules/pos/cart";
import { buildTrustedCartFromCatalog, CartValidationError } from "@/modules/pos/server-cart";
import {
  normalizePriceTier,
  resolveTierBasePrice,
  resolveUnitTierPrice,
} from "@/modules/pos/pricing";
import type { Product, ProductUnit, ProductVariant } from "@/modules/catalog/types";
import type { Cart } from "@/modules/pos/types";

function unit(overrides: Partial<ProductUnit> = {}): ProductUnit {
  return {
    id: "u-dozen",
    productId: "p1",
    storeId: "store-1",
    name: "โหล",
    quantity: 12,
    price: 780,
    priceWholesale: 690,
    priceAgent: null,
    priceRegular: null,
    barcode: "PACK-1",
    sortOrder: 0,
    isActive: true,
    ...overrides,
  };
}

function variant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: "v1",
    productId: "p1",
    name: "มาตรฐาน",
    priceAdjustment: 0,
    trackStock: true,
    stockQuantity: 100,
    isActive: true,
    sortOrder: 0,
    ...overrides,
  };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    storeId: "store-1",
    organizationId: "org-1",
    categoryId: "cat-1",
    name: "น้ำปลาตราปู",
    basePrice: 70,
    priceWholesale: 60,
    priceAgent: 55,
    priceRegular: null,
    unitLabel: "ขวด",
    isActive: true,
    availableForPos: true,
    availableForQr: false,
    sortOrder: 1,
    variants: [],
    units: [unit()],
    modifierGroups: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

describe("pricing tiers", () => {
  it("normalizes unknown tiers to retail", () => {
    expect(normalizePriceTier("wholesale")).toBe("wholesale");
    expect(normalizePriceTier("agent")).toBe("agent");
    expect(normalizePriceTier("regular")).toBe("regular");
    expect(normalizePriceTier("vip")).toBe("retail");
    expect(normalizePriceTier(null)).toBe("retail");
  });

  it("falls back to retail price when a tier price is not configured", () => {
    const p = product();
    expect(resolveTierBasePrice(p, "retail")).toBe(70);
    expect(resolveTierBasePrice(p, "wholesale")).toBe(60);
    expect(resolveTierBasePrice(p, "agent")).toBe(55);
    expect(resolveTierBasePrice(p, "regular")).toBe(70);

    const u = unit();
    expect(resolveUnitTierPrice(u, "retail")).toBe(780);
    expect(resolveUnitTierPrice(u, "wholesale")).toBe(690);
    expect(resolveUnitTierPrice(u, "agent")).toBe(780);
  });
});

describe("cart with pack units", () => {
  it("prices a pack line from the unit tier price and keys it apart from the base line", () => {
    const p = product();
    let cart = addToCart(emptyCart("store-1"), {
      product: p,
      variant: null,
      unit: p.units![0],
      priceTier: "wholesale",
      modifiers: [],
      quantity: 2,
    });
    cart = addToCart(cart, {
      product: p,
      variant: null,
      unit: null,
      priceTier: "wholesale",
      modifiers: [],
      quantity: 3,
    });

    expect(cart.items).toHaveLength(2);
    const packLine = cart.items.find((item) => item.unit);
    const baseLine = cart.items.find((item) => !item.unit);
    expect(packLine?.unitPrice).toBe(690);
    expect(packLine?.totalPrice).toBe(1380);
    expect(packLine?.unit?.quantity).toBe(12);
    expect(baseLine?.unitPrice).toBe(60);
    expect(cart.total).toBe(1380 + 180);
  });

  it("reprices the whole cart when the tier changes", () => {
    const p = product();
    let cart = addToCart(emptyCart("store-1"), {
      product: p,
      variant: null,
      unit: p.units![0],
      priceTier: "retail",
      modifiers: [],
      quantity: 1,
    });
    expect(cart.total).toBe(780);

    cart = repriceCartForTier(cart, [p], "wholesale");
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].unitPrice).toBe(690);
    expect(cart.total).toBe(690);
  });
});

describe("trusted cart with pack units", () => {
  function clientCart(overrides: Partial<Cart> = {}): Cart {
    return {
      storeId: "store-1",
      items: [
        {
          key: "k1",
          productId: "p1",
          productName: "ปลอม",
          categoryId: "cat-1",
          variant: null,
          unit: { id: "u-dozen", name: "ปลอม", quantity: 1 },
          modifiers: [],
          quantity: 2,
          unitPrice: 1,
          totalPrice: 2,
        },
      ],
      subtotal: 2,
      discount: 0,
      total: 2,
      ...overrides,
    };
  }

  it("recomputes unit prices server-side from the catalog and tier", () => {
    const trusted = buildTrustedCartFromCatalog(clientCart(), [product()], {
      storeId: "store-1",
      canDiscount: false,
      priceTier: "wholesale",
    });

    expect(trusted.items[0].unitPrice).toBe(690);
    expect(trusted.items[0].unit).toEqual({ id: "u-dozen", name: "โหล", quantity: 12 });
    expect(trusted.total).toBe(1380);
  });

  it("multiplies variant stock demand by the pack size", () => {
    // 2 โหล = 24 ชิ้น แต่สต๊อกเหลือ 20 → ต้องถูกปฏิเสธ
    const p = product({ variants: [variant({ stockQuantity: 20 })] });
    expect(() =>
      buildTrustedCartFromCatalog(
        clientCart({
          items: [{ ...clientCart().items[0], variant: { id: "v1", name: "มาตรฐาน", priceAdjustment: 0 } }],
        }),
        [p],
        { storeId: "store-1", canDiscount: false, priceTier: "retail" },
      ),
    ).toThrow(CartValidationError);
  });

  it("allows wholesale-size quantities beyond the old 99 cap", () => {
    const trusted = buildTrustedCartFromCatalog(
      clientCart({
        items: [{ ...clientCart().items[0], unit: null, quantity: 500 }],
      }),
      [product()],
      { storeId: "store-1", canDiscount: false, priceTier: "retail" },
    );
    expect(trusted.items[0].quantity).toBe(500);
    expect(trusted.total).toBe(500 * 70);
  });

  it("rejects pack lines that carry modifiers", () => {
    expect(() =>
      buildTrustedCartFromCatalog(
        clientCart({
          items: [
            {
              ...clientCart().items[0],
              modifiers: [
                {
                  modifierGroupId: "g1",
                  modifierGroupName: "หวาน",
                  option: { id: "o1", name: "หวานน้อย", priceAdjustment: 0 },
                },
              ],
            },
          ],
        }),
        [product()],
        { storeId: "store-1", canDiscount: false, priceTier: "retail" },
      ),
    ).toThrow(CartValidationError);
  });

  it("rejects unknown or inactive units", () => {
    expect(() =>
      buildTrustedCartFromCatalog(
        clientCart({
          items: [{ ...clientCart().items[0], unit: { id: "u-missing", name: "ลัง", quantity: 24 } }],
        }),
        [product()],
        { storeId: "store-1", canDiscount: false, priceTier: "retail" },
      ),
    ).toThrow(CartValidationError);
  });
});
