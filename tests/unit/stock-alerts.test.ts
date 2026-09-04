import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeStockAlerts } from "@/modules/stock/repository";
import { isStockPoolLowStockSaleCrossing } from "@/modules/stock/notify";
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

  it("alerts only when a sale movement crosses the Pool threshold", () => {
    expect(isStockPoolLowStockSaleCrossing({ movementType: "sale", beforeQuantity: 6, afterQuantity: 5 }, 5)).toBe(true);
    expect(isStockPoolLowStockSaleCrossing({ movementType: "sale", beforeQuantity: 5, afterQuantity: 4 }, 5)).toBe(false);
    expect(isStockPoolLowStockSaleCrossing({ movementType: "sale", beforeQuantity: 8, afterQuantity: 6 }, 5)).toBe(false);
    for (const movementType of ["receive", "set_balance", "cancel_restore", "item_void_restore", "migration"]) {
      expect(isStockPoolLowStockSaleCrossing({ movementType, beforeQuantity: 6, afterQuantity: 5 }, 5)).toBe(false);
    }
  });

  it("reads committed sale movements, claims each movement once, and includes linked selling items", () => {
    const notifier = readFileSync(join(process.cwd(), "src/modules/stock/notify.ts"), "utf8").toLowerCase().replace(/\s+/g, " ");
    const pos = readFileSync(join(process.cwd(), "src/app/pos/actions.ts"), "utf8").toLowerCase().replace(/\s+/g, " ");
    const qr = readFileSync(join(process.cwd(), "src/app/qr/[storeSlug]/[tableId]/actions.ts"), "utf8").toLowerCase().replace(/\s+/g, " ");

    expect(notifier).toContain('.from("stock_movements")');
    expect(notifier).toContain('.eq("movement_type", "sale")');
    expect(notifier).toContain('.eq("reference_type", "order")');
    expect(notifier).toContain('.eq("reference_id", orderid)');
    expect(notifier).toContain('.from("stock_movement_notification_claims")');
    expect(notifier).toContain("movement_id: movement.id");
    expect(notifier).toContain("stockmovementid: movement.id");
    expect(notifier).toContain("const delivered = await notifyownernow");
    expect(notifier).toContain("if (!delivered)");
    expect(notifier).toMatch(/\.delete\(\)\s*\.eq\("movement_id", movement\.id\)/);
    expect(notifier).toContain("linkeditemnames");
    expect(notifier).toContain("pool.unit_label");
    expect(notifier).toContain("movement.after_quantity");
    expect(pos).toContain("notifylowstockaftersalesafely( ctx.organizationid, ctx.storeid, orderid");
    expect(pos).toContain("notifylowstockaftersalesafely( ctx.organizationid, ctx.storeid, created.orderid");
    expect(qr).toContain("notifylowstockaftersalesafely( store.organization_id, storeid, orderid");
  });

  it("checks open POS creation after commit and rechecks only after payment creates its sale movement", () => {
    const pos = readFileSync(join(process.cwd(), "src/app/pos/actions.ts"), "utf8")
      .toLowerCase()
      .replace(/\s+/g, " ");
    const createCore = pos.slice(
      pos.indexOf("async function createposordercore"),
      pos.indexOf("export async function collectpaymentaction"),
    );
    const collectPayment = pos.slice(
      pos.indexOf("export async function collectpaymentaction"),
      pos.indexOf("export interface checkoutandpayresult"),
    );
    const checkoutAndPay = pos.slice(
      pos.indexOf("export async function checkoutandpayaction"),
      pos.indexOf("export interface opentablestatus"),
    );

    const createFailure = createCore.indexOf("if (result.error)");
    const createNotify = createCore.indexOf("notifylowstockaftersalesafely( ctx.organizationid, ctx.storeid, result.data.id");
    expect(createFailure).toBeGreaterThanOrEqual(0);
    expect(createNotify).toBeGreaterThan(createFailure);
    expect(createCore.slice(createFailure, createNotify)).toContain("return { orderid: null");

    // POS Stock Pool deduction is committed by close payment today, so payment
    // boundaries must recheck; the movement claim prevents duplicate delivery.
    expect(collectPayment).toContain("notifylowstockaftersalesafely( ctx.organizationid, ctx.storeid, orderid");
    expect(checkoutAndPay).toContain("notifylowstockaftersalesafely( ctx.organizationid, ctx.storeid, created.orderid");
    expect(pos.match(/notifylowstockaftersalesafely\(/g)).toHaveLength(3);
  });
});
