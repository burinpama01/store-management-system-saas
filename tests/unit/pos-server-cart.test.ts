import { describe, expect, it } from "vitest";
import { buildTrustedCartFromCatalog } from "@/modules/pos/server-cart";
import type { Product } from "@/modules/catalog/types";
import type { Cart } from "@/modules/pos/types";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    storeId: "store-1",
    organizationId: "org-1",
    categoryId: "cat-1",
    name: "ลาเต้",
    basePrice: 100,
    isActive: true,
    availableForPos: true,
    availableForQr: true,
    sortOrder: 1,
    variants: [],
    modifierGroups: [],
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function cart(overrides: Partial<Cart> = {}): Cart {
  return {
    storeId: "store-1",
    items: [
      {
        key: "tampered",
        productId: "p1",
        productName: "ปลอม",
        categoryId: "cat-x",
        variant: null,
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

describe("buildTrustedCartFromCatalog", () => {
  it("recomputes POS prices from server catalog instead of trusting client totals", () => {
    const trusted = buildTrustedCartFromCatalog(cart(), [product()], {
      storeId: "store-1",
      canDiscount: false,
    });

    expect(trusted.items[0].productName).toBe("ลาเต้");
    expect(trusted.items[0].unitPrice).toBe(100);
    expect(trusted.subtotal).toBe(200);
    expect(trusted.total).toBe(200);
  });

  it("keeps same product rows separate when item notes differ", () => {
    const trusted = buildTrustedCartFromCatalog(
      cart({
        items: [
          { ...cart().items[0], key: "note-1", quantity: 1, note: "ไม่หวาน" },
          { ...cart().items[0], key: "note-2", quantity: 1, note: "แยกน้ำแข็ง" },
        ],
        subtotal: 2,
        total: 2,
      }),
      [product()],
      { storeId: "store-1", canDiscount: false },
    );

    expect(trusted.items).toHaveLength(2);
    expect(trusted.items.map((item) => item.note)).toEqual(["ไม่หวาน", "แยกน้ำแข็ง"]);
    expect(trusted.items.map((item) => item.quantity)).toEqual([1, 1]);
    expect(trusted.subtotal).toBe(200);
  });

  it("merges same product rows only when normalized item notes match", () => {
    const trusted = buildTrustedCartFromCatalog(
      cart({
        items: [
          { ...cart().items[0], key: "note-1", quantity: 1, note: "ไม่หวาน" },
          { ...cart().items[0], key: "note-2", quantity: 1, note: "  ไม่หวาน  " },
        ],
        subtotal: 2,
        total: 2,
      }),
      [product()],
      { storeId: "store-1", canDiscount: false },
    );

    expect(trusted.items).toHaveLength(1);
    expect(trusted.items[0].note).toBe("ไม่หวาน");
    expect(trusted.items[0].quantity).toBe(2);
    expect(trusted.subtotal).toBe(200);
  });

  it("rejects missing required variant and required modifier selections", () => {
    expect(() =>
      buildTrustedCartFromCatalog(
        cart(),
        [
          product({
            variants: [
              {
                id: "v1",
                productId: "p1",
                name: "เย็น",
                priceAdjustment: 10,
                trackStock: false,
                isActive: true,
                sortOrder: 1,
              },
            ],
          }),
        ],
        { storeId: "store-1", canDiscount: false },
      ),
    ).toThrow("กรุณาเลือกขนาดสินค้า");

    expect(() =>
      buildTrustedCartFromCatalog(
        cart(),
        [
          product({
            modifierGroups: [
              {
                id: "g1",
                productId: "p1",
                name: "ความหวาน",
                selectionType: "single",
                isRequired: true,
                minSelections: 1,
                maxSelections: 1,
                sortOrder: 1,
                options: [
                  {
                    id: "o1",
                    modifierGroupId: "g1",
                    name: "หวานน้อย",
                    priceAdjustment: 0,
                    isDefault: false,
                    isActive: true,
                    sortOrder: 1,
                  },
                ],
              },
            ],
          }),
        ],
        { storeId: "store-1", canDiscount: false },
      ),
    ).toThrow("กรุณาเลือก ความหวาน");
  });

  it("rejects discount when the actor does not have discount permission", () => {
    expect(() =>
      buildTrustedCartFromCatalog(cart({ discount: 10, total: 0 }), [product()], {
        storeId: "store-1",
        canDiscount: false,
      }),
    ).toThrow("ไม่มีสิทธิ์ให้ส่วนลด");
  });

  it("rejects tracked variant demand that exceeds stock after merging duplicate cart lines", () => {
    const trackedProduct = product({
      variants: [
        {
          id: "v1",
          productId: "p1",
          name: "เย็น",
          priceAdjustment: 0,
          stockQuantity: 3,
          trackStock: true,
          isActive: true,
          sortOrder: 1,
        },
      ],
    });

    expect(() =>
      buildTrustedCartFromCatalog(
        cart({
          items: [
            {
              ...cart().items[0],
              key: "a",
              variant: { id: "v1", name: "เย็น", priceAdjustment: 0 },
              quantity: 2,
            },
            {
              ...cart().items[0],
              key: "b",
              variant: { id: "v1", name: "เย็น", priceAdjustment: 0 },
              quantity: 2,
            },
          ],
        }),
        [trackedProduct],
        { storeId: "store-1", canDiscount: false },
      ),
    ).toThrow("สินค้าเหลือไม่พอ");
  });

  it("rejects tracked variant demand across different modifier combinations", () => {
    const trackedProduct = product({
      variants: [
        {
          id: "v1",
          productId: "p1",
          name: "เย็น",
          priceAdjustment: 0,
          stockQuantity: 3,
          trackStock: true,
          isActive: true,
          sortOrder: 1,
        },
      ],
      modifierGroups: [
        {
          id: "g1",
          productId: "p1",
          name: "ท็อปปิ้ง",
          selectionType: "multiple",
          isRequired: false,
          minSelections: 0,
          maxSelections: 2,
          sortOrder: 1,
          options: [
            {
              id: "o1",
              modifierGroupId: "g1",
              name: "ไข่มุก",
              priceAdjustment: 10,
              isDefault: false,
              isActive: true,
              sortOrder: 1,
            },
            {
              id: "o2",
              modifierGroupId: "g1",
              name: "วุ้น",
              priceAdjustment: 10,
              isDefault: false,
              isActive: true,
              sortOrder: 2,
            },
          ],
        },
      ],
    });

    expect(() =>
      buildTrustedCartFromCatalog(
        cart({
          items: [
            {
              ...cart().items[0],
              key: "a",
              variant: { id: "v1", name: "เย็น", priceAdjustment: 0 },
              modifiers: [
                {
                  modifierGroupId: "g1",
                  modifierGroupName: "ท็อปปิ้ง",
                  option: { id: "o1", name: "ไข่มุก", priceAdjustment: 10 },
                },
              ],
              quantity: 2,
            },
            {
              ...cart().items[0],
              key: "b",
              variant: { id: "v1", name: "เย็น", priceAdjustment: 0 },
              modifiers: [
                {
                  modifierGroupId: "g1",
                  modifierGroupName: "ท็อปปิ้ง",
                  option: { id: "o2", name: "วุ้น", priceAdjustment: 10 },
                },
              ],
              quantity: 2,
            },
          ],
        }),
        [trackedProduct],
        { storeId: "store-1", canDiscount: false },
      ),
    ).toThrow("สินค้าเหลือไม่พอ");
  });
});
