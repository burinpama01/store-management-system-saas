import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanOnlineCouponCode, evaluateOnlineCoupon, onlineOrderTotal } from "@/modules/online-orders/coupon";
import type { CouponPolicy } from "@/modules/promotions/types";

const STORE = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-12-01T05:00:00Z");

function coupon(partial: Partial<CouponPolicy & { allowOnline: boolean }> = {}): CouponPolicy & { allowOnline: boolean } {
  return {
    id: "c1",
    storeId: STORE,
    code: "SAVE20",
    name: "ลด 20",
    discountType: "amount",
    discountValue: 20,
    minSubtotal: 0,
    startsAt: null,
    endsAt: null,
    isActive: true,
    maxRedemptions: null,
    redeemedCount: 0,
    maxRedemptionsPerCustomer: null,
    customerRedeemedCount: 0,
    customerIds: [],
    stackableWithManualDiscount: false,
    allowOnline: true,
    ...partial,
  };
}

const run = (c: ReturnType<typeof coupon> | null, extra: Partial<Parameters<typeof evaluateOnlineCoupon>[0]> = {}) =>
  evaluateOnlineCoupon({ coupon: c, code: "save20", storeId: STORE, subtotal: 180, deliveryFee: 20, customerId: null, now: NOW, ...extra });

describe("evaluateOnlineCoupon", () => {
  it("ลดเป็นบาท ใช้รหัสตัวเล็ก/ช่องว่างได้", () => {
    expect(run(coupon(), { code: " save 20 " })).toEqual({ ok: true, couponId: "c1", code: "SAVE20", name: "ลด 20", discount: 20 });
  });

  it("ลดเป็น % คิดจากค่าอาหารเท่านั้น ไม่รวมค่าส่ง", () => {
    const r = run(coupon({ discountType: "percentage", discountValue: 10 }));
    expect(r.ok && r.discount).toBe(18);
  });

  it("ไม่พบรหัส", () => {
    expect(run(null)).toEqual({ ok: false, code: "SAVE20", error: "ไม่พบคูปองนี้" });
  });

  it("คูปองหน้าร้านเท่านั้น", () => {
    const r = run(coupon({ allowOnline: false }));
    expect(!r.ok && r.error).toBe("คูปองนี้ใช้ได้ที่หน้าร้านเท่านั้น");
  });

  it("ยอดไม่ถึงขั้นต่ำ บอกยอดขั้นต่ำ", () => {
    const r = run(coupon({ minSubtotal: 200 }));
    expect(!r.ok && r.error).toBe("ยอดค่าอาหารยังไม่ถึงขั้นต่ำของคูปอง (฿200)");
  });

  it("หมดอายุ / ยังไม่เริ่ม / ปิดใช้", () => {
    expect(run(coupon({ endsAt: "2026-11-30T00:00:00Z" })).ok).toBe(false);
    expect(run(coupon({ startsAt: "2026-12-02T00:00:00Z" })).ok).toBe(false);
    expect(run(coupon({ isActive: false })).ok).toBe(false);
  });

  it("ใช้ครบจำนวนแล้ว", () => {
    const r = run(coupon({ maxRedemptions: 5, redeemedCount: 5 }));
    expect(!r.ok && r.error).toBe("คูปองนี้ถูกใช้ครบจำนวนแล้ว");
  });

  it("จำกัดต่อคน/เฉพาะลูกค้า ต้องเป็นสมาชิกที่ล็อกอิน", () => {
    const perCustomer = coupon({ maxRedemptionsPerCustomer: 1 });
    expect(!run(perCustomer).ok && (run(perCustomer) as { error: string }).error).toContain("เฉพาะสมาชิก");
    expect(run(perCustomer, { customerId: "u1" }).ok).toBe(true);
    expect(run(coupon({ maxRedemptionsPerCustomer: 1, customerRedeemedCount: 1 }), { customerId: "u1" }).ok).toBe(false);
    expect(run(coupon({ customerIds: ["u2"] }), { customerId: "u1" }).ok).toBe(false);
    expect(run(coupon({ customerIds: ["u1"] }), { customerId: "u1" }).ok).toBe(true);
  });

  it("ส่วนลดเกินยอด → ตัดให้ยอดชำระเหลือ 1 บาท", () => {
    const r = evaluateOnlineCoupon({ coupon: coupon({ discountValue: 500 }), code: "SAVE20", storeId: STORE, subtotal: 50, deliveryFee: 0, customerId: null, now: NOW });
    expect(r.ok && r.discount).toBe(49);
    expect(onlineOrderTotal(50, 49, 0)).toBe(1);
  });

  it("ส่วนลดเต็มค่าอาหารแต่มีค่าส่ง → ลดได้เต็มค่าอาหาร", () => {
    const r = evaluateOnlineCoupon({ coupon: coupon({ discountType: "percentage", discountValue: 100 }), code: "SAVE20", storeId: STORE, subtotal: 50, deliveryFee: 20, customerId: null, now: NOW });
    expect(r.ok && r.discount).toBe(50);
    expect(onlineOrderTotal(50, 50, 20)).toBe(20);
  });

  it("คูปองร้านอื่น", () => {
    expect(run(coupon({ storeId: "22222222-2222-4222-8222-222222222222" })).ok).toBe(false);
  });
});

describe("cleanOnlineCouponCode", () => {
  it("ตัดช่องว่าง ตัวพิมพ์ใหญ่ ยาวเกิน/อักขระควบคุม = ว่าง", () => {
    expect(cleanOnlineCouponCode(" ab c ")).toBe("ABC");
    expect(cleanOnlineCouponCode("x".repeat(41))).toBe("");
    expect(cleanOnlineCouponCode("AB\u0000C")).toBe("");
    expect(cleanOnlineCouponCode(123)).toBe("");
    expect(cleanOnlineCouponCode("ลดพิเศษ")).toBe("ลดพิเศษ");
  });
});

describe("ด่านฝั่ง server (source)", () => {
  const actions = readFileSync("src/app/s/[slug]/order/actions.ts", "utf8");
  it("สั่งซื้อ: คูปองใช้ไม่ได้ = ไม่สร้างคำสั่งซื้อ และจองสิทธิ์ผ่าน RPC", () => {
    expect(actions).toContain("if (coupon && !coupon.result.ok) return fail(coupon.result.error);");
    expect(actions).toContain("reserveOnlineOrderCoupon(");
    expect(actions).toContain("await deleteFreshOnlineOrder(store.storeId, id);");
  });
  it("ด่านเดาโค้ด: นับเฉพาะตอนกดใช้ และใช้ไม่ได้ทุกกรณีนับเป็นผิด", () => {
    expect(actions).toContain("succeeded: result.ok");
    expect(actions).toContain("{ recordAttempt: true }");
    expect(actions).toContain("{ recordAttempt: false }");
  });
  it("ลูกค้าคูปอง = สมาชิกจาก cookie ไม่ใช่เบอร์ที่พิมพ์", () => {
    expect(actions).toContain("const member = await getMemberSessionByStoreId(store.storeId)");
  });
  it("POS นับเฉพาะรหัสผิดช่องทาง pos", () => {
    expect(readFileSync("src/modules/promotions/coupon-attempt-guard.ts", "utf8")).toContain('.eq("channel" as never, "pos" as never)');
  });
  it("migration: ล็อกแถวคูปอง + คืนสิทธิ์เมื่อยกเลิก", () => {
    const sql = readFileSync("supabase/migrations/20261219120000_online_order_coupons.sql", "utf8");
    expect(sql).toContain("for update;");
    expect(sql).toContain("new.status in ('expired', 'refund_pending', 'refunded', 'delivery_failed')");
    expect(sql).toContain("grant execute on function public.reserve_online_order_coupon(uuid, uuid, uuid, numeric) to service_role;");
  });
});
