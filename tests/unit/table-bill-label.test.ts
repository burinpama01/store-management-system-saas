import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TABLE_BILL_LABEL, tableBillLabel } from "@/modules/pos/table-ticket";
import { buildReceiptLines } from "@/modules/printing/receipt-lines";
import { buildDailySummaryMessage, type StoreDailySummary } from "@/modules/reports/daily-summary";
import type { ReceiptData } from "@/modules/printing/types";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function receipt(overrides: Partial<ReceiptData>): ReceiptData {
  return {
    storeName: "ร้านทดสอบ",
    showTaxId: false,
    orderNumber: "260919-0001",
    items: [{ name: "กาแฟ", modifierNames: [], quantity: 1, unitPrice: 45, totalPrice: 45 }],
    subtotal: 45,
    discount: 0,
    total: 45,
    payments: [{ method: "cash", amount: 45 }],
    showQrPayment: false,
    paperWidth: "80mm",
    printedAt: "2026-09-19T03:00:00.000Z",
    ...overrides,
  } as ReceiptData;
}

describe("table bill is labelled everywhere (counted in QR, not a separate channel)", () => {
  it("builds the label with the table", () => {
    expect(TABLE_BILL_LABEL).toBe("บิลรวมโต๊ะ");
    expect(tableBillLabel("5")).toBe("บิลรวมโต๊ะ · โต๊ะ 5");
    expect(tableBillLabel(null)).toBe("บิลรวมโต๊ะ");
  });

  it("prints the label on the receipt under the order number", () => {
    const withLabel = buildReceiptLines(receipt({ billLabel: "บิลรวมโต๊ะ · โต๊ะ 5" })).lines.map((l) => l.text);
    const orderIndex = withLabel.findIndex((t) => t.startsWith("ออร์เดอร์:"));
    expect(withLabel[orderIndex + 1]).toBe("บิลรวมโต๊ะ · โต๊ะ 5");
    const plain = buildReceiptLines(receipt({})).lines.map((l) => l.text);
    expect(plain.some((t) => t.includes("บิลรวมโต๊ะ"))).toBe(false);
  });

  it("daily summary notes how many QR bills were table bills", () => {
    const store = {
      storeId: "s1",
      storeName: "ร้าน",
      orderCount: 5,
      revenue: 500,
      avgOrderValue: 100,
      posOrderCount: 2,
      qrOrderCount: 3,
      tableBillCount: 2,
      deliveryOrderCount: 0,
      voidedCount: 0,
      paymentMethods: [],
      topProducts: [],
    } as unknown as StoreDailySummary;
    expect(buildDailySummaryMessage(store, "2026-09-19")).toContain("QR 3 (บิลรวมโต๊ะ 2)");
    expect(buildDailySummaryMessage({ ...store, tableBillCount: 0 }, "2026-09-19")).toContain("QR 3");
    expect(buildDailySummaryMessage({ ...store, tableBillCount: 0 }, "2026-09-19")).not.toContain("บิลรวมโต๊ะ");
  });

  it("reports, dashboard, POS history, receipts and the QR board all show it", () => {
    const repo = read("src/modules/reports/repository.ts");
    expect(repo).toContain("function withTableBills(");
    expect(repo).toContain("table_bill_key");
    expect(read("src/app/(dashboard)/reports/ReportsManager.tsx")).toContain("บิลรวมโต๊ะ ${salesSummary.tableBillCount} บิล");
    expect(read("src/app/(dashboard)/dashboard/page.tsx")).toContain("บิลรวมโต๊ะ ${todaySales.tableBillCount}");
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain("{TABLE_BILL_LABEL}");
    expect(pos).toContain("billLabel: order.tableBill ? tableBillLabel(order.tableNumber) : undefined");
    expect(pos).toContain("billLabel: receiptData.billLabel");
    expect(read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx")).toContain("order.tableBill &&");
    expect(read("src/modules/pos/order-repository.ts")).toContain("tableBill: Boolean(row.table_bill_key)");
  });
});
