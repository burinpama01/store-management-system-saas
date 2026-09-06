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

describe("server action ต้องรายงานสาเหตุที่สร้าง QR ไม่ได้", () => {
  const actionSource = read("src/app/pos/actions.ts");

  it("slug, portal token และ host ที่ขาดต้องเป็น error ไม่ใช่ claim null แบบเงียบ", () => {
    expect(actionSource).toContain("ร้านค้ายังไม่มี slug สำหรับ QR รับแต้ม");
    expect(actionSource).toContain("ไม่สามารถสร้างลิงก์สมาชิกสำหรับ QR รับแต้มได้");
    expect(actionSource).toContain("ไม่สามารถระบุ URL สำหรับ QR รับแต้มได้");
    expect(actionSource).not.toContain("if (portal.error || !portal.data?.token) return { error: null, claim: null };");
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

// QR รับแต้มถูกขอจาก server หลังจ่ายเงินแบบไม่บล็อก ถ้าพิมพ์อัตโนมัติยิงทันที
// ใบเสร็จจะออกมา "ไม่มี QR" ทั้งที่ข้อความชวนสแกนพิมพ์ไปแล้ว (เจอที่หน้าร้าน 2026-09-06)
describe("พิมพ์อัตโนมัติต้องรอ QR รับแต้มก่อน", () => {
  const source = read("src/app/pos/PosTerminal.tsx");

  it("ใบเสร็จรู้ว่ากำลังรอ QR อยู่", () => {
    expect(source).toContain("loyaltyClaimPending: !selectedCustomer && Boolean(order.orderId)");
    expect(source).toContain("loyaltyClaimPending: false");
  });

  it("บิล walk-in ใช้ orderId ที่สร้างสำเร็จ ไม่ผูกกับ paidOrder ซึ่ง Unified POS ไม่โหลดกลับมา", () => {
    expect(source).toContain("const claimOrderId = order.orderId;");
    expect(source).not.toContain("!selectedCustomer && paidOrder?.id");
    expect(source).not.toContain("Boolean(paidOrder?.id)");
  });

  it("ยังไม่พิมพ์จนกว่าผล QR จะกลับมา แม้เกินเวลาเตือนแล้ว", () => {
    expect(source).toContain("if (order.loyaltyClaimPending) return;");
    expect(source).not.toContain("if (order.loyaltyClaimPending && !claimWaitElapsed) return;");
    expect(source).toContain("}, [order.loyaltyClaimPending, order.loyaltyClaimError, claimWaitElapsed]);");
    expect(source).toContain("disabled={isPrinting || order.loyaltyClaimPending || Boolean(order.loyaltyClaimError)}");
  });

  it("ครบเวลาแล้วแจ้งว่ากำลังรอ แต่ไม่ปล่อยใบเสร็จที่ไม่มี QR", () => {
    expect(source).toMatch(/const AUTO_PRINT_CLAIM_WAIT_MS = \d+/);
    expect(source).toContain("setTimeout(() => setClaimWaitElapsed(true), AUTO_PRINT_CLAIM_WAIT_MS)");
    expect(source).toContain("กำลังรอ QR รับแต้มจากระบบ");
  });

  it("พิมพ์ซ้ำบิล walk-in ขอ QR รับแต้มด้วย เพื่อกู้บิลที่ใบแรกพิมพ์ไม่ทัน", () => {
    expect(source).toContain("await getReceiptLoyaltyClaimAction(order.id)");
    expect(source).toContain("loyaltyClaim: claimResult?.claim ?? undefined");
  });

  it("สร้าง QR ผิดพลาดต้องหยุด auto-print และแจ้งให้พิมพ์ซ้ำ ไม่กลืน error", () => {
    expect(source).toContain("loyaltyClaimError?: string");
    expect(source).toContain("if (order.loyaltyClaimError) return;");
    expect(source).toContain("QR รับแต้มไม่พร้อม");
    expect(source).toContain("claimResult.error ?? undefined");
  });
});

// รูปที่ร้านอัปโหลดไว้ต้องถูกส่งไปกับข้อมูลใบเสร็จ ไม่งั้น renderer ไม่มีอะไรให้วาด
describe("รูปโลโก้/QR ท้ายใบต้องไปกับใบเสร็จจาก POS", () => {
  const source = read("src/app/pos/PosTerminal.tsx");

  it("ทั้งใบแรกและใบพิมพ์ซ้ำส่งรูปจากการตั้งค่าไปด้วย", () => {
    const occurrences = source.split("logoUrl: settings.logoUrl").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(source.split("footerImageUrl: settings.footerImageUrl").length - 1).toBeGreaterThanOrEqual(2);
    expect(source).toContain("footerImageLabel: settings.footerImageLabel");
    expect(source).toContain("hideFooterImageWithSystemQr: settings.hideFooterImageWithSystemQr");
  });
});
