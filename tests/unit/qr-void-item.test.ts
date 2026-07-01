import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("QR kitchen void line item (out of stock)", () => {
  it("migration adds voided columns + a stock-restoring void RPC", () => {
    const sql = read("supabase/migrations/20260701000002_void_qr_order_item.sql");
    expect(sql).toContain("add column if not exists voided boolean not null default false");
    expect(sql).toContain("create or replace function void_qr_order_item");
    // Only cashier+ of the store may void.
    expect(sql).toContain("auth_user_role_in_store(v_org, p_store_id, 'cashier')");
    // Restores the stock deducted at creation.
    expect(sql).toContain("stock_quantity = coalesce(stock_quantity, 0) + v_qty");
    // Recomputes the order total from remaining lines; cancels when none left.
    expect(sql).toContain("from order_items");
    expect(sql).toContain("update orders set status = 'cancelled'");
  });

  it("kitchen board wires the void action per item", () => {
    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain("voidQrOrderItemAction");
    expect(board).toContain("ของหมด");
    // Voided lines are struck through.
    expect(board).toContain('it.voided ? "text-gray-300 line-through"');
  });

  it("customer tracking shows voided lines struck through", () => {
    const app = read("src/app/qr/[storeSlug]/[tableId]/QrOrderingApp.tsx");
    expect(app).toContain("it.voided");
    expect(app).toContain("voidedReason");
  });
});
