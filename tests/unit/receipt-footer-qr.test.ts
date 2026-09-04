import { describe, it, expect } from "vitest";
import { buildReceiptLines } from "@/modules/printing/receipt-lines";
import type { ReceiptData } from "@/modules/printing/types";

// ใบเสร็จใบเดียวอาจมี QR ได้หลายอัน: ของระบบ (พร้อมเพย์ล็อกยอด / รับแต้ม) และของร้าน
// (รูปที่อัปโหลดไว้ท้ายใบ ซึ่งมักเป็น QR รับเงินและไม่มีข้อความกำกับเลย)
//
// ความเสี่ยงไม่ใช่แค่ "ลูกค้างง" แต่เป็นเงิน:
//   * ใบแจ้งยอด → สแกนผิดอัน = กรอกยอดเอง จ่ายขาด/จ่ายเกิน
//   * บิลที่จ่ายแล้ว → สแกน QR รับเงินของร้าน = โอนซ้ำ
// กติกาที่เทสต์ชุดนี้ล็อกไว้: QR ทุกอันต้องมีป้ายกำกับ + มีกรอบ และรูปท้ายใบต้องหลบให้
// QR ของระบบตามค่าเริ่มต้น (ร้านปิดกฎเองได้)

const baseReceipt = (overrides: Partial<ReceiptData> = {}): ReceiptData => ({
  storeName: "each other II",
  showTaxId: false,
  orderNumber: "260904-105019-2NOY",
  items: [{ name: "Espresso", modifierNames: [], quantity: 1, unitPrice: 40, totalPrice: 40 }],
  subtotal: 40,
  discount: 0,
  total: 40,
  payments: [{ method: "cash", amount: 40 }],
  paymentStatus: "paid",
  showQrPayment: true,
  promptpayId: "1550500160469",
  paperWidth: "80mm",
  printedAt: "2026-09-04T03:50:19.000Z",
  ...overrides,
});

const claim = {
  code: "ABCD1234",
  points: 3.9,
  expiresAt: "2026-09-11T03:50:19.000Z",
  url: "https://www.store-os.online/claim/ABCD1234",
};

const footerLine = (data: ReceiptData) =>
  buildReceiptLines(data).lines.find((line) => line.imageKind === "footer");

const qrLines = (data: ReceiptData) => buildReceiptLines(data).lines.filter((line) => line.qrPayload);

describe("รูป QR ท้ายใบเสร็จของร้าน", () => {
  it("บิลที่ไม่มี QR ของระบบ: พิมพ์รูปท้ายใบพร้อมป้ายกำกับและกรอบ", () => {
    const data = baseReceipt({ footerImageUrl: "https://cdn/qr.jpg", footerImageLabel: "สแกนติดตามร้าน" });
    const { lines } = buildReceiptLines(data);

    const footer = lines.find((line) => line.imageKind === "footer");
    expect(footer?.framed).toBe(true);

    const labelIndex = lines.findIndex((line) => line.text === "สแกนติดตามร้าน");
    const footerIndex = lines.findIndex((line) => line.imageKind === "footer");
    expect(labelIndex).toBeGreaterThan(-1);
    // ป้ายต้องอยู่ติดกันเหนือรูป ไม่ใช่ลอยอยู่คนละที่จนอ่านไม่ออกว่าคู่กัน
    expect(footerIndex - labelIndex).toBe(1);
  });

  it("ไม่ได้ตั้งข้อความกำกับ = ยังต้องมีข้อความกลาง ๆ ไม่ปล่อย QR ลอย ๆ", () => {
    const data = baseReceipt({ footerImageUrl: "https://cdn/qr.jpg" });
    const { lines } = buildReceiptLines(data);
    const footerIndex = lines.findIndex((line) => line.imageKind === "footer");

    expect(lines[footerIndex - 1].text).toBe("สแกน QR ของร้าน");
  });

  it("บิลที่จ่ายแล้วแต่ยังไม่ผูกลูกค้า (มี QR รับแต้ม): ซ่อนรูปท้ายใบตามค่าเริ่มต้น", () => {
    const data = baseReceipt({ footerImageUrl: "https://cdn/qr.jpg", loyaltyClaim: claim });

    expect(footerLine(data)).toBeUndefined();
    expect(qrLines(data)).toHaveLength(1); // เหลือเฉพาะ QR รับแต้ม
  });

  it("ใบแจ้งยอดที่ยังไม่ชำระ (มี QR พร้อมเพย์): ซ่อนรูปท้ายใบตามค่าเริ่มต้น", () => {
    const data = baseReceipt({ paymentStatus: "unpaid", footerImageUrl: "https://cdn/qr.jpg" });

    expect(footerLine(data)).toBeUndefined();
    const qrs = qrLines(data);
    expect(qrs).toHaveLength(1);
    expect(qrs[0].qrAmount).toBe(40); // QR ที่เหลือคืออันที่ล็อกยอดไว้แล้ว
  });

  it("ร้านปิดกฎเองได้ → แสดงทั้งสอง QR แต่ต้องมีป้ายกำกับและกรอบทั้งคู่", () => {
    const data = baseReceipt({
      footerImageUrl: "https://cdn/qr.jpg",
      footerImageLabel: "โอนเข้าบัญชีร้าน",
      hideFooterImageWithSystemQr: false,
      loyaltyClaim: claim,
    });
    const { lines } = buildReceiptLines(data);

    expect(lines.find((line) => line.imageKind === "footer")?.framed).toBe(true);
    expect(lines.filter((line) => line.qrPayload)[0].framed).toBe(true);
    expect(lines.some((line) => line.text === "สแกนรับแต้มสะสม")).toBe(true);
    expect(lines.some((line) => line.text === "โอนเข้าบัญชีร้าน")).toBe(true);
  });

  it("QR ทุกอันมีกรอบและมีบรรทัดเว้นระยะต่อท้าย ไม่ให้ติดกับข้อความถัดไป", () => {
    const data = baseReceipt({ paymentStatus: "unpaid", loyaltyClaim: claim });
    const { lines } = buildReceiptLines(data);

    const qrIndexes = lines.map((line, index) => (line.qrPayload ? index : -1)).filter((i) => i >= 0);
    expect(qrIndexes.length).toBeGreaterThan(0);
    for (const index of qrIndexes) {
      expect(lines[index].framed).toBe(true);
      // หลังบล็อก QR ต้องมีบรรทัดว่างคั่นอย่างน้อยหนึ่งบรรทัด (ก่อนหรือหลังข้อความประกอบ)
      const following = lines.slice(index + 1, index + 4);
      expect(following.some((line) => line.text === "")).toBe(true);
    }
  });
});
