import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONLINE_ORDER_SETTINGS,
  checkoutSchema,
  haversineKm,
  isPaymentWindowOver,
  maskPhone,
  nextStatuses,
  normalizeThaiPhone,
  onlineOrderCode,
  onlineOrderSettingsSchema,
  quoteDelivery,
  type OnlineOrderSettings,
} from "@/modules/online-orders/core";

const read = (path: string) => readFileSync(path, "utf8");
const SHOP = { lat: 13.7563, lng: 100.5018 };
const DELIVERY: OnlineOrderSettings = {
  ...DEFAULT_ONLINE_ORDER_SETTINGS,
  enabled: true,
  deliveryEnabled: true,
  originLat: SHOP.lat,
  originLng: SHOP.lng,
  deliveryRadiusKm: 5,
  deliveryBaseFee: 20,
  deliveryFeePerKm: 10,
};
const UUID = "00000000-0000-4000-8000-000000000001";
const baseCheckout = {
  clientRequestId: "abcdefgh1234",
  fulfillment: "pickup",
  items: [{ productId: UUID, variantId: null, modifierOptionIds: [], quantity: 2 }],
  customerName: "สมชาย",
  customerPhone: "0812345678",
};

describe("ค่าส่ง", () => {
  it("ระยะเส้นตรงถูกต้องคร่าว ๆ (0.01° ลองจิจูด ≈ 1.08 กม. ที่กรุงเทพ)", () => {
    expect(haversineKm(SHOP, { lat: SHOP.lat, lng: SHOP.lng + 0.01 })).toBeCloseTo(1.08, 1);
  });

  it("ค่าเริ่มต้น + ต่อ กม. ปัดขึ้นทีละ 0.5 กม.", () => {
    const q = quoteDelivery(DELIVERY, 100, { lat: SHOP.lat, lng: SHOP.lng + 0.01 });
    expect(q).toMatchObject({ ok: true, fee: 20 + 10 * 1.5 });
  });

  it("ส่งฟรีเมื่อยอดถึง, เกินรัศมีส่งไม่ได้, ไม่มีพิกัดลูกค้าส่งไม่ได้", () => {
    expect(quoteDelivery({ ...DELIVERY, deliveryFreeOver: 300 }, 300, { lat: SHOP.lat, lng: SHOP.lng + 0.01 })).toMatchObject({ ok: true, fee: 0 });
    expect(quoteDelivery(DELIVERY, 100, { lat: SHOP.lat + 0.1, lng: SHOP.lng }).ok).toBe(false);
    expect(quoteDelivery(DELIVERY, 100, null).ok).toBe(false);
    expect(quoteDelivery({ ...DELIVERY, deliveryEnabled: false }, 100, SHOP).ok).toBe(false);
  });
});

describe("สถานะ", () => {
  it("ยกเลิก/คืนเงินในหน้านี้ได้เฉพาะก่อนรับ (หลังรับ บิล POS ปิดด้วยเงิน Beam แล้ว)", () => {
    expect(nextStatuses("paid", "pickup")).toContain("refund_pending");
    expect(nextStatuses("accepted", "pickup")).not.toContain("refund_pending");
    expect(nextStatuses("preparing", "delivery")).not.toContain("refund_pending");
    expect(nextStatuses("refund_pending", "pickup")).toEqual(["refunded"]);
  });

  it("รับที่ร้าน → พร้อมรับ, ส่งถึงบ้าน → กำลังไปส่ง", () => {
    expect(nextStatuses("preparing", "pickup")).toEqual(["ready"]);
    expect(nextStatuses("preparing", "delivery")).toEqual(["out_for_delivery"]);
    expect(nextStatuses("awaiting_payment", "pickup")).toEqual([]);
    expect(nextStatuses("completed", "pickup")).toEqual([]);
  });

  it("หมดเวลาชำระ = หลัง QR หมดอายุ + เผื่อ 15 นาที", () => {
    const expires = "2026-11-16T10:00:00.000Z";
    expect(isPaymentWindowOver(expires, Date.parse("2026-11-16T10:10:00.000Z"))).toBe(false);
    expect(isPaymentWindowOver(expires, Date.parse("2026-11-16T10:16:00.000Z"))).toBe(true);
  });
});

describe("ข้อมูลจากลูกค้า", () => {
  it("ตะกร้ารับแค่สิ่งที่เลือก — ส่งราคามาเองถูกปฏิเสธ", () => {
    expect(checkoutSchema.safeParse(baseCheckout).success).toBe(true);
    expect(checkoutSchema.safeParse({ ...baseCheckout, total: 1 }).success).toBe(false);
    expect(
      checkoutSchema.safeParse({ ...baseCheckout, items: [{ ...baseCheckout.items[0], unitPrice: 1 }] }).success,
    ).toBe(false);
    expect(checkoutSchema.safeParse({ ...baseCheckout, items: [{ ...baseCheckout.items[0], quantity: 0 }] }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...baseCheckout, customerPhone: "12345" }).success).toBe(false);
  });

  it("เบอร์ไทย/ปิดบังเบอร์/รหัสออเดอร์", () => {
    expect(normalizeThaiPhone("+66 81-234-5678")).toBe("0812345678");
    expect(normalizeThaiPhone("081 234 5678")).toBe("0812345678");
    expect(maskPhone("0812345678")).toBe("081-xxx-5678");
    expect(onlineOrderCode("8f2a91c4-0000-4000-8000-000000000000")).toBe("W-8F2A91");
  });

  it("ตั้งค่า: เปิดส่งต้องมีพิกัดร้าน, เปิดสวิตช์ต้องมีอย่างน้อย 1 ช่องทาง", () => {
    expect(onlineOrderSettingsSchema.safeParse(DELIVERY).success).toBe(true);
    expect(onlineOrderSettingsSchema.safeParse({ ...DELIVERY, originLat: null, originLng: null }).success).toBe(false);
    expect(onlineOrderSettingsSchema.safeParse({ ...DELIVERY, pickupEnabled: false, deliveryEnabled: false }).success).toBe(false);
    expect(DEFAULT_ONLINE_ORDER_SETTINGS.enabled).toBe(false);
  });
});

describe("migration + เส้นทางเงิน", () => {
  const sql = read("supabase/migrations/20261121120000_website_online_orders.sql");
  const publicActions = read("src/app/s/[slug]/order/actions.ts");
  const backActions = read("src/app/(dashboard)/website/orders/actions.ts");

  it("ตารางปิดสิทธิ์ anon/authenticated และ trigger แยกเงินเข้าช้า/ยอดไม่ตรง", () => {
    expect(sql).toContain("revoke all on table public.online_orders from anon, authenticated;");
    expect(sql).toContain("revoke all on table public.store_online_order_settings from anon, authenticated;");
    expect(sql).toContain("new.status := 'LATE_PAID';");
    expect(sql).toContain("new.status := 'REVIEW_REQUIRED';");
    expect(sql).toContain("when (new.online_order_id is not null and new.status = 'PAID' and old.status is distinct from 'PAID')");
    expect(sql).toContain("enabled boolean not null default false");
  });

  it("หน้าสาธารณะคิดราคาฝั่ง server และไม่ใช้ session ผู้ใช้", () => {
    expect(publicActions).toContain("await priceCart(store.storeId, input.items)");
    expect(publicActions).not.toContain("createSupabaseServerClient");
    expect(publicActions).toContain("randomBytes(32)");
  });

  it("รับออเดอร์: จองสถานะก่อน แล้วปิดบิลด้วยเงิน Beam ผ่านเส้นทาง POS เดิม", () => {
    expect(backActions).toContain('from: "paid",\n        to: "accepted"');
    expect(backActions).toContain("claimBeamPaymentForOrder");
    expect(backActions).toContain("addPaymentAndClose(");
    expect(backActions).toContain("releaseBeamPaymentClaim");
    expect(backActions).toContain("finalizeBeamPaymentForOrder");
    expect(backActions).toContain('resolved.can("orders.manage_qr")');
  });

  it("กดรับซ้ำหลังล้มกลางทาง: ใช้บิลค้าง (order_number เดิม) ไม่สร้างซ้ำ และไม่ใส่รายการซ้ำ", () => {
    expect(backActions).toContain('.eq("order_number", order.orderCode)');
    expect(backActions).toContain("(existingItems ?? 0) > 0");
  });

  it("หน้าติดตามไม่ใช้ตัวนับในหน่วยความจำ (serverless) และล้างรายการหมดอายุก่อนนับกันสแปม", () => {
    expect(publicActions).not.toContain("lastPoll");
    expect(publicActions).toMatch(/await expireStaleOnlineOrders\(store\.storeId\);\s+const pending/);
    expect(read("src/modules/online-orders/public.ts")).toContain("cache(resolveOrderingStoreUncached)");
  });

  it("ลิงก์สั่งออนไลน์บนเว็บใช้ slug ของเว็บ ไม่ใช่ stores.slug", () => {
    expect(read("src/modules/store-website/repository.ts")).toContain("`/s/${siteRes.data.slug}/order`");
  });
});

describe("พิกัดร้าน = จุดลงเวลาเข้างาน", () => {
  it("ตั้งค่าที่ใช้งานจริงเอาพิกัด geofence ของการเข้างานมาทับ และบันทึกก็ใช้พิกัดเดียวกัน", () => {
    const repo = read("src/modules/online-orders/repository.ts");
    expect(repo).toContain('.from("attendance_settings")');
    expect(repo).toContain("settings: { ...settings, originLat: origin.lat, originLng: origin.lng }, originFromAttendance: true");
    expect(repo).toContain('.order("updated_at", { ascending: false })');
    expect(read("src/app/(dashboard)/website/orders/actions.ts")).toContain("const attendanceOrigin = await getAttendanceOrigin(ctx.storeId);");
    expect(read("src/app/(dashboard)/layout.tsx")).toContain("isOnlineOrderingEnabled(storeContext.storeId)");
  });
});
