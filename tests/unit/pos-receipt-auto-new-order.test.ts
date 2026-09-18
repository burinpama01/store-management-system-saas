import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/app/pos/PosTerminal.tsx"), "utf8");
const panel = source.slice(source.indexOf("function ReceiptPanel("), source.indexOf("// ─── Main POS Terminal"));

describe("receipt screen auto new order", () => {
  it("counts down 10 seconds and then starts a new order", () => {
    expect(source).toContain("const AUTO_NEW_ORDER_SECONDS = 10;");
    expect(panel).toContain("onNewOrderRef.current()");
    expect(panel).toContain("ออร์เดอร์ใหม่ (${secondsLeft})");
    expect(panel).toContain("เริ่มออร์เดอร์ใหม่อัตโนมัติใน {secondsLeft} วินาที");
  });

  it("never leaves while printing or while auto-print still waits for the loyalty QR", () => {
    expect(panel).toMatch(/autoNewOrderPaused =\s*isPrinting \|\| \(Boolean\(receiptSettings\?\.autoPrintReceipt\) && Boolean\(order\.loyaltyClaimPending\)\)/);
  });

  it("stops on errors the cashier must read, and on request", () => {
    expect(panel).toMatch(/autoNewOrderStopped =\s*autoNewOrderCancelled \|\| Boolean\(printError\) \|\| Boolean\(order\.loyaltyClaimError\)/);
    expect(panel).toContain("อยู่หน้านี้ต่อ");
  });
});
