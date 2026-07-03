import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import { buildEscPosReceipt, CMD } from "@/modules/printing/escpos";
import { renderReceiptRaster } from "@/modules/printing/receipt-raster-client";
import { buildReceiptLines } from "@/modules/printing/receipt-lines";
import { buildTableQrReceiptData } from "@/modules/printing/table-qr-slip";
import { floydSteinbergMono } from "@/modules/printing/escpos-raster";
import { browserAdapter } from "@/modules/printing/adapters/browser";
import { bluetoothAdapter } from "@/modules/printing/adapters/bluetooth";
import { buildReceiptPrinterBytes } from "@/modules/printing/receipt-printer-bytes";
import { buildReceiptData, type ReceiptData } from "@/modules/printing/types";
import { ensureBluetoothConnected, getBluetoothPrinterIdentity, getBluetoothPrinterName, printViaBluetooth } from "@/modules/printing/bluetooth-client";
import type { Order } from "@/modules/pos/types";
import type { Printer, ReceiptSettings } from "@/modules/stores/types";

vi.mock("@/modules/printing/bluetooth-client", () => ({
  ensureBluetoothConnected: vi.fn(),
  getBluetoothPrinterIdentity: vi.fn(),
  getBluetoothPrinterName: vi.fn(),
  printViaBluetooth: vi.fn(),
}));

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const receiptFixture: ReceiptData = {
  storeName: "Each Other",
  showTaxId: false,
  orderNumber: "260620-0001",
  items: [{ name: "Latte", modifierNames: [], quantity: 1, unitPrice: 65, totalPrice: 65 }],
  subtotal: 65,
  discount: 0,
  total: 65,
  payments: [{ method: "cash", amount: 65 }],
  showQrPayment: false,
  paperWidth: "58mm",
  printedAt: "2026-06-20T00:00:00.000Z",
};

function printerFixture(overrides: Partial<Printer> = {}): Printer {
  return {
    id: "printer-1",
    storeId: "store-1",
    organizationId: "org-1",
    name: "Counter Bluetooth",
    type: "bluetooth",
    isDefault: true,
    paperWidth: "58mm",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── PromptPay QR ───────────────────────────────────────────────────

describe("buildPromptPayPayload", () => {
  it("generates a non-empty string payload", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678" });
    expect(typeof payload).toBe("string");
    expect(payload.length).toBeGreaterThan(50);
  });

  it("starts with payload format indicator 000201", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678" });
    expect(payload.startsWith("000201")).toBe(true);
  });

  it("ends with 4-char CRC hex", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678" });
    // Last 4 chars after "6304" tag should be hex digits
    const crcPart = payload.slice(-4);
    expect(/^[0-9A-F]{4}$/.test(crcPart)).toBe(true);
  });

  it("includes amount tag (54) when amount is provided", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678", amount: 150 });
    // Tag 54 followed by length and value
    expect(payload).toContain("54");
    expect(payload).toContain("150.00");
  });

  it("does not include amount tag when amount is undefined", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678" });
    // "5402" would be tag 54 with len 02 — should not appear
    expect(payload).not.toContain("5402");
  });

  it("encodes Thai phone 0XXXXXXXXX as the 13-digit EMV mobile proxy", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678" });
    // Mobile proxy: tag 01, length 13, value "0066" + subscriber number.
    expect(payload).toContain("01130066812345678");
  });

  it("treats +66 phone format as a mobile PromptPay ID", () => {
    const payload = buildPromptPayPayload({ recipientId: "+66 81 234 5678" });

    expect(payload).toContain("01130066812345678");
    expect(payload).not.toContain("02130066812345678");
  });

  it("treats compact +66 phone format as a mobile PromptPay ID", () => {
    const payload = buildPromptPayPayload({ recipientId: "+66812345678" });

    expect(payload).toContain("01130066812345678");
    expect(payload).not.toContain("02130066812345678");
  });

  it("uses the national ID PromptPay tag for 13-digit IDs", () => {
    const payload = buildPromptPayPayload({ recipientId: "1234567890123" });

    expect(payload).toContain("02131234567890123");
    expect(payload).not.toContain("01131234567890123");
  });

  it("rejects invalid PromptPay recipient IDs instead of truncating silently", () => {
    expect(() => buildPromptPayPayload({ recipientId: "12345" })).toThrow("Invalid PromptPay recipient ID");
    expect(() => buildPromptPayPayload({ recipientId: "12345678901234" })).toThrow("Invalid PromptPay recipient ID");
    expect(() => buildPromptPayPayload({ recipientId: "abc" })).toThrow("Invalid PromptPay recipient ID");
  });

  it("includes PromptPay app ID", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678" });
    expect(payload).toContain("A000000677010111");
  });

  it("includes country code TH and currency 764", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678" });
    expect(payload).toContain("5802TH");  // tag 58, len 02, value TH
    expect(payload).toContain("5303764"); // tag 53, len 03, value 764
  });
});

// ─── ESC/POS receipt ─────────────────────────────────────────────────

describe("buildEscPosReceipt", () => {
  const baseInput = {
    storeName: "Test Cafe",
    orderNumber: "260518-123456",
    items: [
      { name: "Americano", variantName: "L", modifierNames: ["Less ice"], quantity: 2, totalPrice: 120, note: "No sugar" },
      { name: "Green Tea Latte", variantName: undefined, modifierNames: [], quantity: 1, totalPrice: 65 },
    ],
    subtotal: 185,
    discount: 0,
    total: 185,
    payments: [{ method: "cash", amount: 185, receivedAmount: 200, changeAmount: 15 }],
    paperWidth: "58mm" as const,
    printedAt: new Date().toISOString(),
  };

  it("returns a Uint8Array", () => {
    const result = buildEscPosReceipt(baseInput);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("starts with ESC @ (init command)", () => {
    const result = buildEscPosReceipt(baseInput);
    expect(result[0]).toBe(0x1b); // ESC
    expect(result[1]).toBe(0x40); // @
  });

  it("ends with cut command (GS V)", () => {
    const result = buildEscPosReceipt(baseInput);
    const arr = Array.from(result);
    // Find last GS V sequence
    const cutSeq = CMD.CUT;
    let found = false;
    for (let i = arr.length - cutSeq.length; i >= 0; i--) {
      if (cutSeq.every((b, j) => arr[i + j] === b)) { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it("encodes store name in output", () => {
    const result = buildEscPosReceipt(baseInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("Test Cafe");
  });

  it("encodes order number", () => {
    const result = buildEscPosReceipt(baseInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("260518-123456");
  });

  it("encodes item names", () => {
    const result = buildEscPosReceipt(baseInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("Americano");
    expect(text).toContain("Green Tea Latte");
  });

  it("encodes modifier names", () => {
    const result = buildEscPosReceipt(baseInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("Less ice");
  });

  it("encodes item notes in the ESC/POS text fallback", () => {
    const result = buildEscPosReceipt(baseInput);
    const text = new TextDecoder().decode(result);

    expect(text).toContain("* No sugar");
  });

  it("encodes total", () => {
    const result = buildEscPosReceipt(baseInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("185.00");
  });

  it("encodes change amount when present", () => {
    const result = buildEscPosReceipt(baseInput);
    const text = new TextDecoder().decode(result);
    expect(text).toContain("15.00");
  });

  it("uses received cash as the ESC/POS cash line and keeps change separate", () => {
    const result = buildEscPosReceipt({
      ...baseInput,
      total: 45,
      subtotal: 45,
      payments: [{ method: "cash", amount: 45, receivedAmount: 100, changeAmount: 55 }],
    });
    const text = new TextDecoder().decode(result);
    const cashLine = text.split(/\r?\n/).find((line) => line.includes("Cash")) ?? "";

    expect(cashLine).toContain("100.00");
    expect(text).not.toContain("Received");
    expect(text).toContain("Change");
    expect(text).toContain("55.00");
  });

  it("encodes discount when non-zero", () => {
    const result = buildEscPosReceipt({ ...baseInput, discount: 20, discountNote: "Member" });
    const text = new TextDecoder().decode(result);
    expect(text).toContain("-20.00");
    expect(text).toContain("Member");
  });

  it("produces correct output for 80mm paper", () => {
    const result80 = buildEscPosReceipt({ ...baseInput, paperWidth: "80mm" });
    const result58 = buildEscPosReceipt(baseInput);
    // 80mm output should be larger (wider lines)
    expect(result80.length).toBeGreaterThan(result58.length);
    // 80mm divider (42 chars) should appear in 80mm output
    const text80 = new TextDecoder().decode(result80);
    expect(text80).toContain("-".repeat(42));
    // 58mm divider (32 chars) should NOT appear standalone in 58mm output when using 80mm
    // i.e. 58mm output should NOT contain 42-char divider
    const text58 = new TextDecoder().decode(result58);
    expect(text58).not.toContain("-".repeat(42));
  });
});

describe("buildReceiptLines", () => {
  it("shows cash received and change for overpaid cash receipts", () => {
    const { lines } = buildReceiptLines({
      storeName: "Test Cafe",
      orderNumber: "260620-232241",
      showTaxId: false,
      items: [
        {
          name: "Latte",
          modifierNames: [],
          quantity: 1,
          unitPrice: 45,
          totalPrice: 45,
        },
      ],
      subtotal: 45,
      discount: 0,
      total: 45,
      payments: [{ method: "cash", amount: 45, receivedAmount: 100, changeAmount: 55 }],
      showQrPayment: false,
      paperWidth: "58mm",
      printedAt: "2026-06-20T16:24:00.000Z",
    });

    const text = lines.map((line) => line.text).join("\n");
    const cashLine = lines.find((line) => line.text.includes("เงินสด"))?.text ?? "";

    expect(cashLine).toContain("เงินสด");
    expect(cashLine).toContain("100.00");
    expect(text).toContain("45.00");
    expect(text).not.toContain("รับเงิน");
    expect(text).toContain("เงินทอน");
    expect(text).toContain("55.00");
  });

  it("places the store logo at the top and the footer image at the very bottom", () => {
    const { lines } = buildReceiptLines({
      ...receiptFixture,
      logoUrl: "https://cdn.example.com/logo.png",
      footerImageUrl: "https://cdn.example.com/line-qr.png",
      footerText: "ขอบคุณที่อุดหนุน",
    });

    const imageLines = lines.filter((line) => line.imageUrl);
    expect(imageLines).toHaveLength(2);

    // Logo is the first line (before the store name); footer image is the last line.
    expect(lines[0]?.imageUrl).toBe("https://cdn.example.com/logo.png");
    expect(lines[0]?.imageKind).toBe("logo");
    expect(lines[lines.length - 1]?.imageUrl).toBe("https://cdn.example.com/line-qr.png");
    expect(lines[lines.length - 1]?.imageKind).toBe("footer");
  });

  it("omits image lines when no logo or footer image is configured", () => {
    const { lines } = buildReceiptLines(receiptFixture);
    expect(lines.some((line) => line.imageUrl)).toBe(false);
  });

  it("renders a station kitchen ticket with quantities but no prices or payments", () => {
    const { lines } = buildReceiptLines({
      ...receiptFixture,
      ticketMode: "kitchen",
      stationName: "ครัวร้อน",
      tableNumber: "7",
      items: [
        { name: "ผัดกะเพรา", modifierNames: ["เผ็ดมาก"], quantity: 2, unitPrice: 0, totalPrice: 0, note: "ไข่ดาว" },
      ],
    });
    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("ครัวร้อน");
    expect(text).toContain("ตั๋วเตรียมอาหาร");
    expect(text).toContain("โต๊ะ: 7");
    expect(text).toContain("2 x ผัดกะเพรา");
    expect(text).toContain("+ เผ็ดมาก");
    expect(text).toContain("* ไข่ดาว");
    // Kitchen tickets never show money or payment sections.
    expect(text).not.toContain("รวมสุทธิ");
    expect(text).not.toContain("เงินสด");
    expect(text).not.toMatch(/\d+\.\d{2}/);
  });

  it("buildTableQrReceiptData produces a table_qr receipt carrying the ordering URL", () => {
    const data = buildTableQrReceiptData({
      storeName: "Each Other",
      tableLabel: "12",
      qrPayload: "https://shop.example/qr/each-other/abc-123",
      validUntil: "2026-06-30T15:00:00.000Z",
      paperWidth: "58mm",
    });
    expect(data.ticketMode).toBe("table_qr");
    expect(data.tableQrPayload).toBe("https://shop.example/qr/each-other/abc-123");
    expect(data.tableNumber).toBe("12");
    expect(data.paperWidth).toBe("58mm");
    // buildReceiptLines must render its QR line from this data.
    expect(buildReceiptLines(data).lines.some((l) => l.qrPayload)).toBe(true);
  });

  it("renders a table-open QR slip with a scannable qrPayload line and no prices", () => {
    const { lines } = buildReceiptLines({
      ...receiptFixture,
      ticketMode: "table_qr",
      tableNumber: "12",
      tableQrPayload: "https://shop.example/qr/each-other/abc-123",
      tableValidUntil: "2026-06-30T15:00:00.000Z",
      items: [],
    });
    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("ใบเปิดโต๊ะ");
    expect(text).toContain("โต๊ะ 12");
    expect(text).toContain("สแกนเพื่อสั่งอาหาร");
    expect(lines.some((line) => line.qrPayload === "https://shop.example/qr/each-other/abc-123")).toBe(true);
    expect(text).not.toContain("รวมสุทธิ");
    expect(text).not.toMatch(/\d+\.\d{2}/);
  });

  it("shows earned and remaining loyalty points when a paid receipt has customer rewards", () => {
    const { lines } = buildReceiptLines({
      ...receiptFixture,
      loyaltyPointsEarned: 12,
      loyaltyPointsBalance: 240,
    });

    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("แต้มที่ได้รับ");
    expect(text).toContain("+12");
    expect(text).toContain("แต้มคงเหลือ");
    expect(text).toContain("240");
  });

  it("does not print a loyalty section when no points were earned", () => {
    const { lines } = buildReceiptLines({
      ...receiptFixture,
      loyaltyPointsEarned: 0,
      loyaltyPointsBalance: 240,
    });

    const text = lines.map((line) => line.text).join("\n");

    expect(text).not.toContain("สะสมแต้ม");
    expect(text).not.toContain("แต้มที่ได้รับ");
    expect(text).not.toContain("แต้มคงเหลือ");
  });

  it("passes paid customer reward points from POS payment results into receipt data", () => {
    const normalPos = read("src/app/pos/PosTerminal.tsx");
    const groceryPos = read("src/app/pos/grocery/GroceryPosTerminal.tsx");
    const escpos = read("src/modules/printing/escpos.ts");
    const orderRepository = read("src/modules/pos/order-repository.ts");
    const types = read("src/modules/printing/types.ts");

    expect(types).toContain("loyaltyPointsEarned?: number");
    expect(types).toContain("loyaltyPointsBalance?: number");
    expect(escpos).toContain("loyaltyPointsEarned?: number");
    expect(escpos).toContain("loyaltyPointsBalance?: number");
    expect(orderRepository).toContain('.from("loyalty_accounts")');
    expect(orderRepository).toContain("loyaltyPointsBalance");
    expect(normalPos).toContain("loyaltyPointsEarned: paidOrder?.loyaltyPointsEarned");
    expect(normalPos).toContain("loyaltyPointsBalance: paidOrder?.loyaltyPointsBalance");
    expect(groceryPos).toContain("loyaltyPointsEarned: order.loyaltyPointsEarned");
    expect(groceryPos).toContain("loyaltyPointsBalance: order.loyaltyPointsBalance");
  });

  it("shows item-level discount details on receipt lines", () => {
    const { lines } = buildReceiptLines({
      storeName: "Test Cafe",
      orderNumber: "260618-123456",
      showTaxId: false,
      items: [
        {
          name: "Latte",
          modifierNames: ["Less sweet"],
          quantity: 1,
          unitPrice: 35,
          totalPrice: 31.5,
          discount: 3.5,
          discountType: "percentage",
          discountValue: 10,
          discountNote: "สมาชิก",
        },
      ],
      subtotal: 31.5,
      discount: 0,
      total: 31.5,
      payments: [{ method: "cash", amount: 31.5 }],
      showQrPayment: false,
      paperWidth: "58mm",
      printedAt: "2026-06-18T00:00:00.000Z",
    });

    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("ส่วนลดรายการ");
    expect(text).toContain("-3.50");
    expect(text).toContain("สมาชิก");
  });

  it("adds a locked PromptPay QR block without printing the EMV payload as text", () => {
    const { lines } = buildReceiptLines({
      storeName: "Test Cafe",
      orderNumber: "260622-0001",
      showTaxId: false,
      items: [
        {
          name: "Latte",
          modifierNames: [],
          quantity: 1,
          unitPrice: 45,
          totalPrice: 45,
        },
      ],
      subtotal: 45,
      discount: 0,
      total: 45,
      payments: [{ method: "qr_promptpay", amount: 45 }],
      paymentStatus: "unpaid",
      showQrPayment: true,
      promptpayId: "0812345678",
      paperWidth: "58mm",
      printedAt: "2026-06-22T00:00:00.000Z",
    });

    const text = lines.map((line) => line.text).join("\n");
    const qrLine = lines.find((line) => (line as { qrPayload?: string }).qrPayload);

    expect(text).toContain("QR PromptPay");
    expect(text).toContain("45.00");
    expect(text).not.toContain("000201");
    expect(qrLine).toMatchObject({ qrAmount: 45 });
    expect((qrLine as { qrPayload?: string }).qrPayload).toContain("A000000677010111");
  });

  it("does not add a PromptPay QR block to paid receipts even when receipt QR is enabled", () => {
    const { lines } = buildReceiptLines({
      ...receiptFixture,
      payments: [{ method: "qr_promptpay", amount: 65 }],
      paymentStatus: "paid",
      showQrPayment: true,
      promptpayId: "0812345678",
    });

    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("QR PromptPay");
    expect(text).not.toContain("QR PromptPay ล็อกยอด");
    expect(lines.some((line) => Boolean((line as { qrPayload?: string }).qrPayload))).toBe(false);
  });

  it("wraps a 1000-character receipt footer instead of rendering it as one squeezed line", () => {
    const { lines, cols } = buildReceiptLines({
      ...receiptFixture,
      footerText: "F".repeat(1000),
    });

    const footerLines = lines.filter((line) => /^F+$/.test(line.text));

    expect(footerLines.length).toBeGreaterThan(20);
    expect(footerLines.every((line) => line.text.length <= cols)).toBe(true);
  });

  it("wraps long Thai footer text without starting a line with a combining mark", () => {
    const thaiFooter = "ขอบคุณที่ใช้บริการ ร้านกาแฟชุมชน ยินดีต้อนรับกลับมาอีกครั้ง ".repeat(25);
    const { lines, cols } = buildReceiptLines({
      ...receiptFixture,
      footerText: thaiFooter,
    });
    const div = "-".repeat(cols);
    const footerStart = lines.map((line) => line.text).lastIndexOf(div);
    const footerLines = lines.slice(footerStart + 1);
    const startsWithCombiningMark = (text: string) => /^\p{Mark}/u.test(text);
    const segmenter =
      typeof Intl !== "undefined" && "Segmenter" in Intl
        ? new Intl.Segmenter("th", { granularity: "grapheme" })
        : null;
    const graphemeCount = (text: string) =>
      segmenter ? Array.from(segmenter.segment(text)).length : Array.from(text).length;

    expect(footerLines.length).toBeGreaterThan(20);
    expect(footerLines.every((line) => graphemeCount(line.text) <= cols)).toBe(true);
    expect(footerLines.some((line) => startsWithCombiningMark(line.text))).toBe(false);
  });

  it("keeps Thai combining marks attached when Intl.Segmenter is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
      const thaiFooter = "กำลังชำระเงินแล้ว ขอบคุณค่ะ ".repeat(40);
      const { lines, cols } = buildReceiptLines({
        ...receiptFixture,
        footerText: thaiFooter,
      });
      const div = "-".repeat(cols);
      const footerStart = lines.map((line) => line.text).lastIndexOf(div);
      const footerLines = lines.slice(footerStart + 1);
      const startsWithCombiningMark = (text: string) => /^\p{Mark}/u.test(text);

      expect(footerLines.length).toBeGreaterThan(20);
      expect(footerLines.some((line) => startsWithCombiningMark(line.text))).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(Intl, "Segmenter", descriptor);
      } else {
        Reflect.deleteProperty(Intl, "Segmenter");
      }
    }
  });

  it("keeps Thai sara am attached when Intl.Segmenter is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
      const thaiFooter = `${"F".repeat(31)}กำลังชำระเงินแล้ว`;
      const { lines, cols } = buildReceiptLines({
        ...receiptFixture,
        footerText: thaiFooter,
        paperWidth: "58mm",
      });
      const div = "-".repeat(cols);
      const footerStart = lines.map((line) => line.text).lastIndexOf(div);
      const footerLines = lines.slice(footerStart + 1);
      const startsWithDetachedThaiMark = (text: string) => /^[\p{Mark}\u0E33]/u.test(text);

      expect(cols).toBe(32);
      expect(footerLines.every((line) => line.text.length <= cols)).toBe(true);
      expect(footerLines.some((line) => startsWithDetachedThaiMark(line.text))).toBe(false);
    } finally {
      if (descriptor) {
        Object.defineProperty(Intl, "Segmenter", descriptor);
      } else {
        Reflect.deleteProperty(Intl, "Segmenter");
      }
    }
  });
});

describe("floydSteinbergMono", () => {
  function solid(width: number, height: number, gray: number): Uint8ClampedArray {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = gray;
      rgba[i * 4 + 1] = gray;
      rgba[i * 4 + 2] = gray;
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  it("maps fully black and fully white regions to all-on / all-off dots", () => {
    const black = floydSteinbergMono(solid(8, 8, 0), 8, 8);
    const white = floydSteinbergMono(solid(8, 8, 255), 8, 8);
    expect(black.every((v) => v === 1)).toBe(true);
    expect(white.every((v) => v === 0)).toBe(true);
  });

  it("dithers a mid-gray region into a mix of on and off dots", () => {
    const mono = floydSteinbergMono(solid(16, 16, 128), 16, 16);
    const onDots = mono.reduce((sum, v) => sum + v, 0);
    // ~50% gray should diffuse into roughly half-on dots, never all-or-nothing.
    expect(onDots).toBeGreaterThan(mono.length * 0.25);
    expect(onDots).toBeLessThan(mono.length * 0.75);
  });

  it("treats transparent pixels as white (off)", () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4); // all zero → transparent black
    const mono = floydSteinbergMono(rgba, 4, 4);
    expect(mono.every((v) => v === 0)).toBe(true);
  });
});

describe("printer adapters", () => {
  it("wires bluetooth adapter instead of leaving the printer type unsupported", () => {
    const service = read("src/modules/printing/print-service.ts");
    const adapter = read("src/modules/printing/adapters/bluetooth.ts");

    expect(service).toContain("bluetoothAdapter");
    expect(service).toContain("bluetooth: bluetoothAdapter");
    expect(adapter).toContain("Web Bluetooth ไม่รองรับ");
    expect(adapter).toContain("ensureBluetoothConnected");
    expect(adapter).toContain("printViaBluetooth");
    expect(adapter).toContain("buildReceiptPrinterBytes(data, data)");
    expect(adapter).not.toContain("service/characteristic");
  });

  it("keeps mobile/browser fallback paths when the print popup is blocked", () => {
    const adapter = read("src/modules/printing/adapters/browser.ts");

    expect(adapter).toContain("fallbackReceiptDownload");
    expect(adapter).toContain("navigator.share");
    expect(adapter).toContain("URL.createObjectURL");
    expect(adapter).toContain("เบราว์เซอร์บล็อกหน้าต่างพิมพ์");
  });

  it("renders header logo and footer image as <img> blocks in the browser receipt HTML", async () => {
    const documentWrite = vi.fn();
    const browserReceipt = {
      ...receiptFixture,
      logoUrl: "https://cdn.example.com/logo.png",
      footerImageUrl: "https://cdn.example.com/line-qr.png",
    } satisfies ReceiptData;

    vi.stubGlobal("window", {
      open: vi.fn(() => ({
        document: { open: vi.fn(), write: documentWrite, close: vi.fn() },
        focus: vi.fn(),
        print: vi.fn(),
        addEventListener: vi.fn(),
        close: vi.fn(),
      })),
    });

    await browserAdapter.print(browserReceipt, printerFixture({ type: "browser" }));

    const html = String(documentWrite.mock.calls[0]?.[0] ?? "");
    expect(html).toContain('class="receipt-image is-logo"');
    expect(html).toContain('<img src="https://cdn.example.com/logo.png"');
    expect(html).toContain('class="receipt-image is-footer"');
    expect(html).toContain('<img src="https://cdn.example.com/line-qr.png"');
    // Logo must appear before the footer image in the document order.
    expect(html.indexOf("logo.png")).toBeLessThan(html.indexOf("line-qr.png"));
  });

  it("loads raster images via the same-origin proxy + blob bitmap so they don't taint the canvas on IP/Print Hub prints", () => {
    const rasterClient = read("src/modules/printing/receipt-raster-client.ts");

    // Same-origin proxy first → no CORS/cache/browser variance, canvas never tainted.
    expect(rasterClient).toContain("/api/receipt-image?src=${encodeURIComponent(url)}");
    // Blob-decoded bitmaps never taint the canvas → getImageData works → image
    // is included in the raster bytes sent to IP/USB/Bluetooth/Print Hub.
    expect(rasterClient).toContain("createImageBitmap(await res.blob())");
    // Last-resort <img> must cache-bust so it cannot reuse a non-CORS cache entry.
    expect(rasterClient).toContain("storeosCors=1");
    expect(rasterClient).toContain('img.crossOrigin = "anonymous"');
  });

  it("receipt-image proxy only allows Supabase storage public objects (SSRF guard)", () => {
    const route = read("src/app/api/receipt-image/route.ts");
    const middleware = read("src/server/integrations/supabase/middleware.ts");

    expect(route).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(route).toContain('url.pathname.startsWith("/storage/v1/object/public/")');
    expect(route).toContain("url.origin !== base.origin");
    expect(route).toContain('contentType.startsWith("image/")');
    expect(route).toContain("MAX_IMAGE_BYTES");
    // The proxy must be a public route so the auth redirect never replaces the
    // image with the login HTML (which would break the raster image load).
    expect(middleware).toContain('request.nextUrl.pathname === "/api/receipt-image"');
  });

  it("downloads the receipt when popup print is blocked and native share rejects", async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const link = { href: "", download: "", rel: "", click, remove };
    const createElement = vi.fn(() => link);
    const createObjectURL = vi.fn(() => "blob:receipt");
    const revokeObjectURL = vi.fn();
    const share = vi.fn().mockRejectedValue(new Error("share denied"));

    vi.stubGlobal("window", {
      open: vi.fn(() => null),
      setTimeout: vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
    });
    vi.stubGlobal("document", {
      createElement,
      body: { appendChild },
    });
    vi.stubGlobal("navigator", {
      canShare: vi.fn(() => true),
      share,
    });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("File", class extends Blob {
      readonly name: string;

      constructor(parts: BlobPart[], name: string, options?: FilePropertyBag) {
        super(parts, options);
        this.name = name;
      }
    });

    await browserAdapter.print(receiptFixture, printerFixture({ type: "browser" }));

    expect(share).toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalled();
    expect(appendChild).toHaveBeenCalledWith(link);
    expect(click).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:receipt");
  });

  it("writes received cash and change correctly in the browser receipt HTML", async () => {
    const documentWrite = vi.fn();
    const print = vi.fn();
    const focus = vi.fn();
    const close = vi.fn();
    const addEventListener = vi.fn();
    const browserReceipt = {
      ...receiptFixture,
      subtotal: 45,
      total: 45,
      payments: [{ method: "cash", amount: 45, receivedAmount: 100, changeAmount: 55 }],
    } satisfies ReceiptData;

    vi.stubGlobal("window", {
      open: vi.fn(() => ({
        document: {
          open: vi.fn(),
          write: documentWrite,
          close,
        },
        focus,
        print,
        addEventListener,
        close,
      })),
    });

    await browserAdapter.print(browserReceipt, printerFixture({ type: "browser" }));

    const html = String(documentWrite.mock.calls[0]?.[0] ?? "");
    const receiptText = html.replace(/<[^>]+>/g, "\n");

    expect(receiptText).toContain("เงินสด");
    expect(receiptText).toContain("100.00");
    expect(receiptText).not.toContain("รับเงิน");
    expect(receiptText).toContain("เงินทอน");
    expect(receiptText).toContain("55.00");
    expect(print).toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith("afterprint", expect.any(Function));
  });

  it("renders PromptPay QR as an image block in the browser receipt HTML", async () => {
    const documentWrite = vi.fn();
    const print = vi.fn();
    const focus = vi.fn();
    const close = vi.fn();
    const addEventListener = vi.fn();
    const browserReceipt = {
      ...receiptFixture,
      payments: [{ method: "qr_promptpay", amount: 65 }],
      paymentStatus: "unpaid",
      showQrPayment: true,
      promptpayId: "0812345678",
    } satisfies ReceiptData;

    vi.stubGlobal("window", {
      open: vi.fn(() => ({
        document: {
          open: vi.fn(),
          write: documentWrite,
          close,
        },
        focus,
        print,
        addEventListener,
        close,
      })),
    });

    await browserAdapter.print(browserReceipt, printerFixture({ type: "browser" }));

    const html = String(documentWrite.mock.calls[0]?.[0] ?? "");

    expect(html).toContain("QR PromptPay ล็อกยอด");
    expect(html).toContain("promptpay-qr");
    expect(html).toContain("<svg");
    expect(html).not.toContain("000201");
    expect(print).toHaveBeenCalled();
  });

  it("wires escpos adapter so schema printer type fails closed with clear setup guidance", () => {
    const service = read("src/modules/printing/print-service.ts");
    const adapter = read("src/modules/printing/adapters/escpos.ts");

    expect(service).toContain("escposAdapter");
    expect(service).toContain("escpos: escposAdapter");
    expect(adapter).toContain("sendNetworkPrintJob");
    expect(adapter).not.toContain("/api/print/ip");
    expect(adapter).toContain("ESC/POS ต้องเลือกเครื่องพิมพ์จากการตั้งค่าร้าน");
  });

  it("server-side network printing only allows DB-bound private LAN printers", async () => {
    const { isAllowedNetworkPrinterHost } = await import("@/modules/printing/network-printer");

    expect(isAllowedNetworkPrinterHost("192.168.1.50")).toBe(true);
    expect(isAllowedNetworkPrinterHost("10.0.0.20")).toBe(true);
    expect(isAllowedNetworkPrinterHost("172.16.4.10")).toBe(true);
    expect(isAllowedNetworkPrinterHost("172.31.255.250")).toBe(true);

    expect(isAllowedNetworkPrinterHost("127.0.0.1")).toBe(false);
    expect(isAllowedNetworkPrinterHost("169.254.1.1")).toBe(false);
    expect(isAllowedNetworkPrinterHost("8.8.8.8")).toBe(false);
    expect(isAllowedNetworkPrinterHost("::1")).toBe(false);
    expect(isAllowedNetworkPrinterHost("999.1.1.1")).toBe(false);
  });

  it("IP and ESC/POS adapters send printerId to the server route instead of trusting client printer details", () => {
    const ipAdapter = read("src/modules/printing/adapters/ip.ts");
    const escposAdapter = read("src/modules/printing/adapters/escpos.ts");
    const route = read("src/app/api/print/ip/route.ts");

    expect(ipAdapter).toContain("printerId: printer.id");
    expect(escposAdapter).toContain("printerId: printer.id");
    expect(ipAdapter).not.toContain("printer }");
    expect(escposAdapter).not.toContain("printer: { ...printer");
    expect(route).toContain("printerId");
    expect(route).not.toContain("printer: Printer");
  });

  it("USB adapter releases a claimed interface before closing the device", () => {
    const adapter = read("src/modules/printing/adapters/usb.ts");
    const claimIndex = adapter.indexOf("await device.claimInterface(ep.interfaceNum)");
    const releaseIndex = adapter.indexOf("await device.releaseInterface(ep.interfaceNum)");
    const closeIndex = adapter.indexOf("await device.close().catch");
    const finallyIndex = adapter.indexOf("finally");

    expect(claimIndex).toBeGreaterThan(-1);
    expect(finallyIndex).toBeGreaterThan(claimIndex);
    expect(releaseIndex).toBeGreaterThan(finallyIndex);
    expect(closeIndex).toBeGreaterThan(releaseIndex);
  });

  it("configured raw printer adapters share the raster-first receipt byte builder", () => {
    const usbAdapter = read("src/modules/printing/adapters/usb.ts");
    const ipAdapter = read("src/modules/printing/adapters/ip.ts");
    const escposAdapter = read("src/modules/printing/adapters/escpos.ts");
    const router = read("src/modules/printing/print-router.ts");
    const route = read("src/app/api/print/ip/route.ts");

    expect(router).toContain("buildReceiptPrinterBytes");
    expect(usbAdapter).toContain("buildReceiptPrinterBytes(data, data)");
    expect(usbAdapter).not.toContain("buildEscPosReceipt({");
    expect(ipAdapter).toContain("printJobBase64");
    expect(ipAdapter).toContain("buildReceiptPrinterBytes(data, data)");
    expect(escposAdapter).toContain("printJobBase64");
    expect(escposAdapter).toContain("buildReceiptPrinterBytes(data, data)");
    expect(route).toContain("printJobBase64");
  });

  it("thermal byte builder repeats a receipt job for configured print copies", () => {
    const builder = read("src/modules/printing/receipt-printer-bytes.ts");

    expect(builder).toContain("normalizePrintCopies(browser.printCopies)");
    expect(builder).toContain("repeatReceiptJob");
  });

  it("thermal byte builder repeats the actual receipt bytes for configured print copies", async () => {
    const single = await buildReceiptPrinterBytes(receiptFixture, { ...receiptFixture, printCopies: 1 });
    const repeated = await buildReceiptPrinterBytes(receiptFixture, { ...receiptFixture, printCopies: 3 });

    expect(repeated.length).toBe(single.length * 3);
    expect(Array.from(repeated.slice(0, single.length))).toEqual(Array.from(single));
    expect(Array.from(repeated.slice(single.length, single.length * 2))).toEqual(Array.from(single));
    expect(Array.from(repeated.slice(single.length * 2))).toEqual(Array.from(single));
  });

  it("does not fall back to text ESC/POS when PromptPay QR needs raster output", async () => {
    await expect(
      buildReceiptPrinterBytes(
        receiptFixture,
        {
          ...receiptFixture,
          payments: [{ method: "qr_promptpay", amount: 65 }],
          paymentStatus: "unpaid",
          showQrPayment: true,
          promptpayId: "0812345678",
        },
      ),
    ).rejects.toThrow("raster");
  });

  it("renders a PromptPay QR block into ESC/POS raster bytes", async () => {
    type MockCanvas = {
      width: number;
      height: number;
      getContext(type: "2d"): MockCanvasContext;
    };
    type MockCanvasContext = {
      fillStyle: string;
      textBaseline: string;
      font: string;
      textAlign: CanvasTextAlign;
      fillRect(x: number, y: number, width: number, height: number): void;
      fillText(text: string, x: number, y: number, maxWidth?: number): void;
      getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
    };

    const fillRects: Array<{ x: number; y: number; width: number; height: number; fillStyle: string }> = [];
    let pixelBuffer = new Uint8ClampedArray();
    let canvasWidth = 0;
    let canvasHeight = 0;

    const ensureBuffer = () => {
      const needed = canvasWidth * canvasHeight * 4;
      if (pixelBuffer.length !== needed) pixelBuffer = new Uint8ClampedArray(needed);
    };
    const paint = (x: number, y: number, width: number, height: number, fillStyle: string) => {
      ensureBuffer();
      const black = fillStyle === "#000";
      for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(canvasHeight, Math.ceil(y + height)); yy += 1) {
        for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(canvasWidth, Math.ceil(x + width)); xx += 1) {
          const offset = (yy * canvasWidth + xx) * 4;
          pixelBuffer[offset] = black ? 0 : 255;
          pixelBuffer[offset + 1] = black ? 0 : 255;
          pixelBuffer[offset + 2] = black ? 0 : 255;
          pixelBuffer[offset + 3] = 255;
        }
      }
    };
    const ctx: MockCanvasContext = {
      fillStyle: "#000",
      textBaseline: "top",
      font: "",
      textAlign: "left",
      fillRect(x, y, width, height) {
        fillRects.push({ x, y, width, height, fillStyle: this.fillStyle });
        paint(x, y, width, height, this.fillStyle);
      },
      fillText: vi.fn(),
      getImageData: vi.fn((_x, _y, width, height) => {
        ensureBuffer();
        return { data: pixelBuffer.slice(0, width * height * 4) };
      }),
    };
    const canvas: MockCanvas = {
      get width() {
        return canvasWidth;
      },
      set width(value: number) {
        canvasWidth = value;
      },
      get height() {
        return canvasHeight;
      },
      set height(value: number) {
        canvasHeight = value;
      },
      getContext: vi.fn(() => ctx),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => canvas),
    });

    const job = await renderReceiptRaster({
      ...receiptFixture,
      payments: [{ method: "qr_promptpay", amount: 65 }],
      paymentStatus: "unpaid",
      showQrPayment: true,
      promptpayId: "0812345678",
    });

    expect(job).toBeInstanceOf(Uint8Array);
    const bytes = Array.from(job ?? []);
    const rasterCommandIndex = bytes.findIndex((byte, index) =>
      byte === 0x1d && bytes[index + 1] === 0x76 && bytes[index + 2] === 0x30 && bytes[index + 3] === 0,
    );
    const qrDots = fillRects.filter((rect) => rect.fillStyle === "#000" && rect.width >= 3 && rect.height >= 3);
    const storeNameTextCalls = vi.mocked(ctx.fillText).mock.calls.filter(([text]) => text === "Each Other");

    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(rasterCommandIndex).toBeGreaterThanOrEqual(2);
    expect(bytes.slice(rasterCommandIndex + 8, -7).some((byte) => byte !== 0)).toBe(true);
    expect(qrDots.length).toBeGreaterThan(50);
    expect(storeNameTextCalls).toHaveLength(2);
    expect(Number(storeNameTextCalls[1]?.[1])).toBeCloseTo(Number(storeNameTextCalls[0]?.[1]) + 0.7);
  });

  it("turns light gray anti-aliased receipt text into black raster dots", async () => {
    type MockCanvas = {
      width: number;
      height: number;
      getContext(type: "2d"): MockCanvasContext;
    };
    type MockCanvasContext = {
      fillStyle: string;
      textBaseline: string;
      font: string;
      textAlign: CanvasTextAlign;
      fillRect(x: number, y: number, width: number, height: number): void;
      fillText(text: string, x: number, y: number, maxWidth?: number): void;
      getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
    };

    let canvasWidth = 0;
    let canvasHeight = 0;
    let pixelBuffer = new Uint8ClampedArray();
    const ensureBuffer = () => {
      const needed = canvasWidth * canvasHeight * 4;
      if (pixelBuffer.length !== needed) pixelBuffer = new Uint8ClampedArray(needed);
    };
    const paintPixel = (x: number, y: number, value: number) => {
      ensureBuffer();
      const xx = Math.max(0, Math.min(canvasWidth - 1, Math.floor(x)));
      const yy = Math.max(0, Math.min(canvasHeight - 1, Math.floor(y)));
      const offset = (yy * canvasWidth + xx) * 4;
      pixelBuffer[offset] = value;
      pixelBuffer[offset + 1] = value;
      pixelBuffer[offset + 2] = value;
      pixelBuffer[offset + 3] = 255;
    };
    const ctx: MockCanvasContext = {
      fillStyle: "#000",
      textBaseline: "top",
      font: "",
      textAlign: "left",
      fillRect() {
        ensureBuffer();
        pixelBuffer.fill(this.fillStyle === "#000" ? 0 : 255);
      },
      fillText: vi.fn((_text, x, y) => {
        paintPixel(x, y, 190);
      }),
      getImageData: vi.fn((_x, _y, width, height) => {
        ensureBuffer();
        return { data: pixelBuffer.slice(0, width * height * 4) };
      }),
    };
    const canvas: MockCanvas = {
      get width() {
        return canvasWidth;
      },
      set width(value: number) {
        canvasWidth = value;
      },
      get height() {
        return canvasHeight;
      },
      set height(value: number) {
        canvasHeight = value;
      },
      getContext: vi.fn(() => ctx),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

    const job = await renderReceiptRaster(receiptFixture);
    const bytes = Array.from(job ?? []);
    const rasterCommandIndex = bytes.findIndex((byte, index) =>
      byte === 0x1d && bytes[index + 1] === 0x76 && bytes[index + 2] === 0x30 && bytes[index + 3] === 0,
    );
    const rasterPayload = bytes.slice(rasterCommandIndex + 8, -7);

    expect(rasterCommandIndex).toBeGreaterThanOrEqual(2);
    expect(rasterPayload.some((byte) => byte !== 0)).toBe(true);
    expect(ctx.fillText).toHaveBeenCalled();
  });

  it("does not print to a connected Bluetooth device that does not match the configured printer", async () => {
    vi.stubGlobal("navigator", { bluetooth: {} });
    vi.mocked(ensureBluetoothConnected).mockResolvedValue(true);
    vi.mocked(getBluetoothPrinterIdentity).mockReturnValue("bt-other");
    vi.mocked(getBluetoothPrinterName).mockReturnValue("Other printer");

    await expect(
      bluetoothAdapter.print(receiptFixture, printerFixture({ bluetoothDeviceId: "bt-expected" })),
    ).rejects.toThrow("ไม่ตรงกับเครื่องพิมพ์ Bluetooth");

    expect(printViaBluetooth).not.toHaveBeenCalled();
  });
});

describe("receipt data", () => {
  it("carries the configured print copy count into runtime receipt data", () => {
    const order: Order = {
      id: "order-1",
      storeId: "store-1",
      organizationId: "org-1",
      orderNumber: "260620-0001",
      status: "paid",
      cashierId: "cashier-1",
      tableNumber: "12",
      items: [
        {
          id: "item-1",
          orderId: "order-1",
          productId: "product-1",
          productName: "Latte",
          modifiers: [],
          quantity: 1,
          unitPrice: 65,
          totalPrice: 65,
        },
      ],
      subtotal: 65,
      discount: 0,
      total: 65,
      payments: [
        {
          id: "payment-1",
          orderId: "order-1",
          method: "cash",
          amount: 65,
          status: "completed",
          processedAt: "2026-06-20T00:00:00.000Z",
          processedByUserId: "cashier-1",
        },
      ],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      paidAt: "2026-06-20T00:00:00.000Z",
    };
    const settings: ReceiptSettings = {
      id: "settings-1",
      storeId: "store-1",
      organizationId: "org-1",
      storeName: "Each Other",
      showTaxId: false,
      showQrPayment: false,
      autoPrintReceipt: false,
      autoPrintStationTickets: false,
      paperWidth: "80mm",
      printCopies: 3,
      showVatBreakdown: false,
      vatRate: 7,
      updatedAt: "2026-06-20T00:00:00.000Z",
    };

    expect(buildReceiptData(order, settings).printCopies).toBe(3);
  });

  it("uses the post-payment customer loyalty balance from the order receipt payload", () => {
    const order: Order = {
      id: "order-1",
      storeId: "store-1",
      organizationId: "org-1",
      orderNumber: "260620-0001",
      status: "paid",
      cashierId: "cashier-1",
      customerId: "customer-1",
      loyaltyPointsEarned: 12,
      loyaltyPointsBalance: 240,
      items: [],
      subtotal: 1200,
      discount: 0,
      total: 1200,
      payments: [],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      paidAt: "2026-06-20T00:00:00.000Z",
    };
    const settings: ReceiptSettings = {
      id: "settings-1",
      storeId: "store-1",
      organizationId: "org-1",
      storeName: "Each Other",
      showTaxId: false,
      showQrPayment: false,
      autoPrintReceipt: false,
      autoPrintStationTickets: false,
      paperWidth: "80mm",
      printCopies: 1,
      showVatBreakdown: false,
      vatRate: 7,
      updatedAt: "2026-06-20T00:00:00.000Z",
    };

    expect(buildReceiptData(order, settings)).toMatchObject({
      loyaltyPointsEarned: 12,
      loyaltyPointsBalance: 240,
    });
  });

  it("omits zero earned points from generated receipt data", () => {
    const order: Order = {
      id: "order-1",
      storeId: "store-1",
      organizationId: "org-1",
      orderNumber: "260620-0001",
      status: "paid",
      cashierId: "cashier-1",
      customerId: "customer-1",
      loyaltyPointsEarned: 0,
      loyaltyPointsBalance: 240,
      items: [],
      subtotal: 50,
      discount: 0,
      total: 50,
      payments: [],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      paidAt: "2026-06-20T00:00:00.000Z",
    };
    const settings: ReceiptSettings = {
      id: "settings-1",
      storeId: "store-1",
      organizationId: "org-1",
      storeName: "Each Other",
      showTaxId: false,
      showQrPayment: false,
      autoPrintReceipt: false,
      autoPrintStationTickets: false,
      paperWidth: "80mm",
      printCopies: 1,
      showVatBreakdown: false,
      vatRate: 7,
      updatedAt: "2026-06-20T00:00:00.000Z",
    };

    expect(buildReceiptData(order, settings).loyaltyPointsEarned).toBeUndefined();
    expect(buildReceiptData(order, settings).loyaltyPointsBalance).toBeUndefined();
  });
});
