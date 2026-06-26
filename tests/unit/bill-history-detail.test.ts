import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const terminal = readFileSync(join(root, "src/app/pos/PosTerminal.tsx"), "utf8");

describe("bill history — view full bill detail", () => {
  it("adds a ดูรายละเอียด button that opens a bill detail modal", () => {
    expect(terminal).toContain("ดูรายละเอียด");
    expect(terminal).toContain("function BillDetailModal");
    expect(terminal).toContain("setDetailOrder(order)");
    expect(terminal).toContain("<BillDetailModal");
    // modal shows full line items, totals, and payment breakdown
    expect(terminal).toContain("function paymentMethodLabel");
    expect(terminal).toContain("order.items.map");
    expect(terminal).toContain("order.payments.map");
    expect(terminal).toContain("เงินทอน");
  });
});
