// สะสมแต้มแบบรวดเร็ว: QR รับแต้มท้ายใบเสร็จ
// (บิลที่ยังไม่ผูกลูกค้า → ลูกค้าสแกนรับแต้มเองภายหลัง แคชเชียร์ไม่ต้องทำอะไร)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReceiptLines } from "@/modules/printing/receipt-lines";
import type { ReceiptData } from "@/modules/printing/types";
import { buildLoyaltyClaimUrl } from "@/modules/loyalty/claim-repository";
import { formatPoints } from "@/shared/utils/points";

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
    printedAt: "2026-09-03T10:00:00.000Z",
    ...overrides,
  } as ReceiptData;
}

describe("QR รับแต้มบนใบเสร็จ", () => {
  const claim = {
    url: "https://shop.example.com/member/my-store?code=abc&claim=8B7D9C24",
    code: "8B7D9C24",
    points: 2.5,
    expiresAt: "2026-09-10T10:00:00.000Z",
  };

  it("บิลที่ยังไม่ผูกลูกค้า → พิมพ์ QR + รหัส + แต้ม + วันหมดอายุ", () => {
    const { lines } = buildReceiptLines(receipt({ loyaltyClaim: claim }));
    const text = lines.map((l) => l.text).join("\n");

    expect(text).toContain("สแกนรับแต้มสะสม");
    // ใช้ตัวจัดรูปแบบแต้มเดียวกับที่เหลือของใบเสร็จ (formatPoints)
    expect(text).toContain(`รับ ${formatPoints(claim.points)} แต้ม`);
    expect(text).toContain("รหัส 8B7D9C24");
    expect(text).toContain("1 บิลรับได้ครั้งเดียว");
    expect(lines.some((l) => l.qrPayload === claim.url)).toBe(true);
  });

  it("บิลปกติ (ไม่มีรหัส) ต้องไม่มีส่วนนี้เลย", () => {
    const { lines } = buildReceiptLines(receipt());
    const text = lines.map((l) => l.text).join("\n");
    expect(text).not.toContain("สแกนรับแต้ม");
    expect(lines.some((l) => l.qrPayload)).toBe(false);
  });

  it("บิลที่ได้แต้มไปแล้ว ยังแสดงสรุปแต้มเหมือนเดิม", () => {
    const { lines } = buildReceiptLines(receipt({ loyaltyPointsEarned: 5, loyaltyPointsBalance: 20 }));
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("สะสมแต้ม");
    expect(text).not.toContain("สแกนรับแต้มสะสม");
  });
});

describe("URL ที่ฝังใน QR", () => {
  it("พาไปหน้าสมาชิกของร้าน พร้อมรหัสร้านและรหัสรับแต้ม", () => {
    const url = buildLoyaltyClaimUrl({
      baseUrl: "https://shop.example.com",
      storeSlug: "my-store",
      portalToken: "tok123",
      code: "8B7D9C24",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/member/my-store");
    expect(parsed.searchParams.get("code")).toBe("tok123");
    expect(parsed.searchParams.get("claim")).toBe("8B7D9C24");
  });

  it("ชื่อร้านที่มีอักขระพิเศษต้องถูก encode", () => {
    const url = buildLoyaltyClaimUrl({
      baseUrl: "https://shop.example.com",
      storeSlug: "ร้าน ก",
      portalToken: "t",
      code: "AAAAAAAA",
    });
    expect(url).toContain("/member/%");
    expect(() => new URL(url)).not.toThrow();
  });
});

describe("กติกาที่ต้องบังคับในฐานข้อมูล", () => {
  const migration = read("supabase/migrations/20260903000002_loyalty_claim_codes.sql");

  it("1 บิล 1 รหัส และรับได้ครั้งเดียว", () => {
    expect(migration).toContain("order_id                uuid not null unique");
    expect(migration).toContain("'already_claimed'");
    expect(migration).toContain("on conflict (store_id, idempotency_key) do nothing");
  });

  it("หมดอายุใน 7 วัน และเช็คก่อนให้แต้ม", () => {
    expect(migration).toContain("now() + interval '7 days'");
    expect(migration).toContain("'expired'");
  });

  it("บิลที่ผูกลูกค้าแล้วต้องไม่ได้รหัส (กันแต้มซ้ำ)", () => {
    expect(migration).toContain("if v_order.customer_id is not null then return null; end if;");
  });

  it("คิดแต้มด้วยสูตรเดียวกับตอนจ่ายเงินปกติ", () => {
    expect(migration).toContain("round(coalesce(v_order.total, 0) * v_ppc, 2)");
    expect(migration).toContain("else 0.0100");
  });

  it("RPC ไม่เปิดให้ client เรียกตรง", () => {
    expect(migration).toContain("revoke all on function public.create_loyalty_claim_code");
    expect(migration).toContain("revoke all on function public.claim_loyalty_points");
  });
});
