// ใบพิมพ์ซ้ำต้องแยกจากใบจริงด้วยตาเปล่า ไม่งั้นใบเดียวกันถูกเอาไปเบิก/ลงบัญชีสองรอบได้
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReceiptLines } from "@/modules/printing/receipt-lines";
import { prependReprintBanner } from "@/modules/unified-pos/print-intent";
import type { ReceiptData } from "@/modules/printing/types";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

function receipt(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    storeName: "ร้านทดสอบ",
    showTaxId: false,
    orderNumber: "A-001",
    items: [{ name: "ลาเต้", modifierNames: [], quantity: 1, unitPrice: 60, totalPrice: 60 }],
    subtotal: 60,
    discount: 0,
    total: 60,
    payments: [{ method: "cash", amount: 60 }],
    paymentStatus: "paid",
    showQrPayment: false,
    paperWidth: "80mm",
    printedAt: "2026-09-06T10:00:00.000Z",
    ...overrides,
  } as ReceiptData;
}

describe("ป้ายพิมพ์ซ้ำบนใบเสร็จ", () => {
  it("ใบปกติไม่มีป้าย", () => {
    const { lines } = buildReceiptLines(receipt());
    expect(lines.some((line) => line.text.includes("REPRINT"))).toBe(false);
  });

  it("ใบพิมพ์ซ้ำมีป้ายอยู่ก่อนรายการสินค้า", () => {
    const { lines } = buildReceiptLines(receipt({ isReprint: true }));
    const bannerIndex = lines.findIndex((line) => line.text.includes("REPRINT"));
    const itemIndex = lines.findIndex((line) => line.text.includes("ลาเต้"));
    expect(bannerIndex).toBeGreaterThanOrEqual(0);
    expect(lines[bannerIndex].align).toBe("center");
    expect(lines[bannerIndex].bold).toBe(true);
    expect(bannerIndex).toBeLessThan(itemIndex);
  });

  it("ใบเปิดโต๊ะที่พิมพ์ซ้ำก็มีป้ายเหมือนกัน", () => {
    const { lines } = buildReceiptLines(
      receipt({ ticketMode: "table_qr", isReprint: true, tableQrPayload: "https://example.com/qr" }),
    );
    expect(lines.some((line) => line.text.includes("REPRINT"))).toBe(true);
  });
});

// unified POS พิมพ์ซ้ำด้วยไบต์เดิมเป๊ะ (เซิร์ฟเวอร์ rebuild ใบไม่ได้ เพราะ render ในเบราว์เซอร์)
// ป้ายจึงต้องแปะไว้ข้างหน้าโดยไม่แตะไบต์ใบเสร็จเดิม
describe("ป้ายพิมพ์ซ้ำของ unified POS", () => {
  const original = Buffer.from([0x1b, 0x40, 0x41, 0x42, 0x43]).toString("base64");

  it("ไบต์ใบเสร็จเดิมยังอยู่ครบและอยู่ท้ายป้าย", () => {
    const out = Buffer.from(prependReprintBanner(original), "base64");
    const originalBytes = Buffer.from(original, "base64");
    expect(out.length).toBeGreaterThan(originalBytes.length);
    expect(out.subarray(out.length - originalBytes.length)).toEqual(originalBytes);
  });

  it("ป้ายเป็น ASCII อ่านออกโดยไม่ต้องพึ่ง code page ภาษาไทย", () => {
    const out = Buffer.from(prependReprintBanner(original), "base64");
    expect(out.subarray(0, out.length - 5).toString("latin1")).toContain("*** REPRINT ***");
  });
});

describe("จุดที่สั่งพิมพ์ซ้ำต้องติดธงไปด้วย", () => {
  it("POS หลัก (พิมพ์ซ้ำจากประวัติบิล)", () => {
    expect(read("src/app/pos/PosTerminal.tsx")).toContain("isReprint: true");
  });

  it("POS ขายของชำ — ปุ่มพิมพ์ซ้ำติดธง แต่พิมพ์อัตโนมัติหลังจ่ายเงินไม่ติด", () => {
    const source = read("src/app/pos/grocery/GroceryPosTerminal.tsx");
    expect(source).toContain("isReprint: options.reprint === true");
    expect(source).toContain("handlePrintReceipt(order, { reprint: true })");
  });
});
