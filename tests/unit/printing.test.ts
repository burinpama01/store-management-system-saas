import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import { buildEscPosReceipt, CMD } from "@/modules/printing/escpos";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

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

  it("converts Thai phone 0XXXXXXXXX to 66XXXXXXXXX", () => {
    const payload = buildPromptPayPayload({ recipientId: "0812345678" });
    // Should contain 66812345678 in the merchant account field
    expect(payload).toContain("011166812345678");
    expect(payload).toContain("66812345678");
  });

  it("treats +66 phone format as a mobile PromptPay ID", () => {
    const payload = buildPromptPayPayload({ recipientId: "+66 81 234 5678" });

    expect(payload).toContain("011166812345678");
    expect(payload).not.toContain("021166812345678");
  });

  it("treats compact +66 phone format as a mobile PromptPay ID", () => {
    const payload = buildPromptPayPayload({ recipientId: "+66812345678" });

    expect(payload).toContain("011166812345678");
    expect(payload).not.toContain("021166812345678");
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

describe("printer adapters", () => {
  it("wires bluetooth adapter instead of leaving the printer type unsupported", () => {
    const service = read("src/modules/printing/print-service.ts");
    const adapter = read("src/modules/printing/adapters/bluetooth.ts");

    expect(service).toContain("bluetoothAdapter");
    expect(service).toContain("bluetooth: bluetoothAdapter");
    expect(adapter).toContain("Web Bluetooth ไม่รองรับ");
    expect(adapter).toContain("service/characteristic");
  });

  it("wires escpos adapter so schema printer type fails closed with clear setup guidance", () => {
    const service = read("src/modules/printing/print-service.ts");
    const adapter = read("src/modules/printing/adapters/escpos.ts");

    expect(service).toContain("escposAdapter");
    expect(service).toContain("escpos: escposAdapter");
    expect(adapter).toContain("/api/print/ip");
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
});
