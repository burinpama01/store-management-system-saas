import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("#8 POS/QR stock deduction — no double deduct", () => {
  const fix = read("supabase/migrations/20260607000006_pos_stock_dedup.sql");
  const qrRpc = read("supabase/migrations/20260601000006_qr_order_rpc.sql");

  it("QR orders decrement stock at creation", () => {
    expect(qrRpc).toContain("update product_variants");
    expect(qrRpc).toContain("stock_quantity = stock_quantity - v_stock.requested_quantity");
  });

  it("close_pos_order_payment skips stock deduction for QR orders (already deducted)", () => {
    expect(fix).toContain("create or replace function close_pos_order_payment");
    // guard so QR orders are not decremented twice
    expect(fix).toContain("if not v_order.qr_order_source then");
    // POS path still has the out-of-stock guard + decrement
    expect(fix).toContain("raise exception 'สินค้าเหลือไม่พอ'");
    expect(fix).toContain("set stock_quantity = stock_quantity - v_stock.requested_quantity");
    // the decrement loop must be inside the qr_order_source guard
    const guardIdx = fix.indexOf("if not v_order.qr_order_source then");
    const loopIdx = fix.indexOf("for v_stock in");
    const updIdx = fix.indexOf("update product_variants");
    expect(guardIdx).toBeGreaterThan(0);
    expect(loopIdx).toBeGreaterThan(guardIdx);
    expect(updIdx).toBeGreaterThan(loopIdx);
  });
});
