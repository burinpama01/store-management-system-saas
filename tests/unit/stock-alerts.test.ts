import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeStockAlerts } from "@/modules/stock/repository";
import type { Product } from "@/modules/catalog/types";

function product(
  id: string,
  name: string,
  variants: Product["variants"],
): Product {
  return {
    id,
    storeId: "store-1",
    organizationId: "org-1",
    categoryId: "cat-1",
    name,
    basePrice: 10,
    isActive: true,
    availableForPos: true,
    availableForQr: true,
    sortOrder: 1,
    variants,
    modifierGroups: [],
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
  };
}

describe("computeStockAlerts", () => {
  it("returns tracked variants at or below the threshold", () => {
    const alerts = computeStockAlerts(
      [
        product("p1", "ลาเต้", [
          {
            id: "v1",
            productId: "p1",
            name: "เย็น",
            priceAdjustment: 0,
            stockQuantity: 2,
            trackStock: true,
            isActive: true,
            sortOrder: 1,
          },
          {
            id: "v2",
            productId: "p1",
            name: "ร้อน",
            priceAdjustment: 0,
            stockQuantity: 10,
            trackStock: true,
            isActive: true,
            sortOrder: 2,
          },
        ]),
      ],
      5,
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      productId: "p1",
      variantId: "v1",
      productName: "ลาเต้",
      variantName: "เย็น",
      stockQuantity: 2,
      severity: "low",
    });
  });

  it("marks zero or negative stock as out", () => {
    const alerts = computeStockAlerts(
      [
        product("p1", "ชาไทย", [
          {
            id: "v1",
            productId: "p1",
            name: "ปกติ",
            priceAdjustment: 0,
            stockQuantity: 0,
            trackStock: true,
            isActive: true,
            sortOrder: 1,
          },
        ]),
      ],
      5,
    );

    expect(alerts[0].severity).toBe("out");
  });

  it("ignores inactive, untracked, and unknown quantity variants", () => {
    const alerts = computeStockAlerts(
      [
        product("p1", "โกโก้", [
          {
            id: "v1",
            productId: "p1",
            name: "ไม่ติดตาม",
            priceAdjustment: 0,
            stockQuantity: 0,
            trackStock: false,
            isActive: true,
            sortOrder: 1,
          },
          {
            id: "v2",
            productId: "p1",
            name: "ปิดขาย",
            priceAdjustment: 0,
            stockQuantity: 0,
            trackStock: true,
            isActive: false,
            sortOrder: 2,
          },
          {
            id: "v3",
            productId: "p1",
            name: "ไม่ระบุจำนวน",
            priceAdjustment: 0,
            trackStock: true,
            isActive: true,
            sortOrder: 3,
          },
        ]),
      ],
      5,
    );

    expect(alerts).toHaveLength(0);
  });

  it("keeps QR ordering stock guard wired to variant stock fields", () => {
    const action = readFileSync(
      join(process.cwd(), "src/app/qr/[storeSlug]/[tableId]/actions.ts"),
      "utf8",
    );

    expect(action).toContain("stock_quantity");
    expect(action).toContain("track_stock");
    expect(action).toContain("requestedStockByVariant");
    expect(action).toContain("สินค้าเหลือไม่พอ");
  });
});
