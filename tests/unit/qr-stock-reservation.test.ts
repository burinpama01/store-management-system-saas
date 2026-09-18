import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  availablePoolUnits,
  availableVariantStock,
  sellableVariantUnits,
  type ProductVariant,
} from "@/modules/catalog/types";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function variant(overrides: Partial<ProductVariant>): ProductVariant {
  return {
    id: "v1",
    productId: "p1",
    name: "S",
    priceAdjustment: 0,
    trackStock: true,
    stockQuantity: 10,
    reservedQuantity: 0,
    isActive: true,
    sortOrder: 0,
    ...overrides,
  };
}

describe("available stock = real stock − QR reservations", () => {
  it("subtracts reservations from tracked variants and ignores untracked ones", () => {
    expect(availableVariantStock(variant({ stockQuantity: 10, reservedQuantity: 3 }))).toBe(7);
    expect(availableVariantStock(variant({ trackStock: false }))).toBeUndefined();
    expect(availableVariantStock(variant({ stockQuantity: undefined }))).toBeUndefined();
  });

  it("uses the Stock Pool (minus its reservations) when the variant is linked to one", () => {
    const pooled = variant({
      stockQuantity: 0,
      stockPool: { poolId: "pool", poolName: "", unitLabel: "", quantity: 20, reservedUnits: 5, consumptionQuantity: 2 },
    });
    expect(availablePoolUnits(pooled.stockPool!)).toBe(15);
    expect(sellableVariantUnits(pooled)).toBe(7);
  });

  it("never reports negative sellable units (stock reduced below reservations)", () => {
    expect(sellableVariantUnits(variant({ stockQuantity: 2, reservedQuantity: 5 }))).toBe(0);
  });
});

describe("reservation wiring", () => {
  const migration = read("supabase/migrations/20260918030000_qr_stock_reservation.sql");

  it("QR orders reserve instead of deducting and the lifecycle trigger owns commit/release", () => {
    expect(migration).toContain("perform public.qr_reserve_order_stock(v_order_id, p_store_id, p_organization_id);");
    expect(migration).toContain("create trigger qr_order_stock_lifecycle");
    expect(migration).toContain("when (old.stock_state = 'reserved')");
    // เส้นทางเดิมที่ต้องหักยอดจองก่อนขาย
    expect(migration).toContain("v_pool.quantity::bigint - coalesce(v_pool.reserved_units, 0) < v_demand.required_units");
    expect(migration).toContain("v_variant.stock_quantity::bigint - coalesce(v_variant.reserved_quantity, 0) < v_stock.requested_quantity");
  });

  it("POS and QR submit checks use available stock, not raw stock", () => {
    expect(read("src/modules/pos/server-cart.ts")).toContain("availableVariantStock(variant)");
    expect(read("src/modules/pos/server-cart.ts")).toContain("availablePoolUnits(pool)");
    const qr = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    expect(qr).toContain("variant.stock_quantity - (variant.reserved_quantity ?? 0)");
    expect(qr).toContain("availablePoolUnits(pool)");
  });

  it("kitchen board accepts (commits stock) and can reject a whole order", () => {
    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain('new: { next: "preparing", label: "รับออเดอร์" }');
    expect(board).toContain("rejectQrOrderAction");
  });

  it("whole-order reject is one DB transaction and kitchen logging is best-effort (review #63)", () => {
    const actions = read("src/app/(dashboard)/qr-orders/actions.ts");
    const reject = actions.slice(actions.indexOf("export async function rejectQrOrderAction"));
    expect(reject).toContain("rejectQrOrder(ctx.storeId, orderId, trimmed)");
    expect(reject).not.toContain("for (const itemId");
    expect(actions).not.toContain("await logSystemEvent(");
    expect(actions).toContain(".catch(() => undefined)");
    const migration = read("supabase/migrations/20260918030000_qr_stock_reservation.sql");
    expect(migration).toContain("create or replace function public.reject_qr_order(");
  });

  it("product cards never add up variants that may share one Stock Pool", () => {
    const app = read("src/app/qr/[storeSlug]/[tableId]/QrOrderingApp.tsx");
    expect(app).toContain("const units = product.variants.length === 1 ? perVariant[0] : undefined;");
    expect(app).not.toContain("total += units");
  });
});
