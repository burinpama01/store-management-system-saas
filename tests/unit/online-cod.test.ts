import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES,
  COD_FAILED_BLOCK_COUNT,
  COD_OTP_MAX_ATTEMPTS,
  DEFAULT_ONLINE_ORDER_SETTINGS,
  STATUS_LABEL,
  canTransition,
  checkoutSchema,
  codCapFor,
  nextStatuses,
  onlineOrderSettingsSchema,
} from "@/modules/online-orders/core";

const read = (p: string) => readFileSync(p, "utf8");

describe("R3 เก็บเงินปลายทาง — กติกา", () => {
  it("ค่าเริ่มต้นปิดทุกร้าน + บังคับ OTP + เพดาน 500", () => {
    expect(DEFAULT_ONLINE_ORDER_SETTINGS).toMatchObject({ codEnabled: false, codRequireOtp: true, codMaxPerBill: 500, codTierCaps: {} });
    expect(onlineOrderSettingsSchema.safeParse(DEFAULT_ONLINE_ORDER_SETTINGS).success).toBe(true);
  });

  it("เพดาน: ระดับที่ตั้งไว้ใช้ของระดับ · ไม่ใช่สมาชิก/ไม่ได้ตั้ง ใช้ต่อบิล", () => {
    const s = { codMaxPerBill: 500, codTierCaps: { "2": 1500, "3": 0 } };
    expect(codCapFor(s, null)).toBe(500);
    expect(codCapFor(s, 1)).toBe(500);
    expect(codCapFor(s, 2)).toBe(1500);
    expect(codCapFor(s, 3)).toBe(0);
  });

  it("สถานะ: cod_pending รับ/ปฏิเสธได้ · ออกไปส่งแล้ว COD ส่งไม่สำเร็จได้ · Beam ไม่ได้", () => {
    expect(nextStatuses("cod_pending", "delivery", "cod")).toEqual(["accepted", "delivery_failed"]);
    expect(canTransition("out_for_delivery", "delivery_failed", "delivery", "cod")).toBe(true);
    expect(canTransition("out_for_delivery", "delivery_failed", "delivery", "beam")).toBe(false);
    expect(canTransition("out_for_delivery", "delivery_failed", "delivery")).toBe(false);
    expect(ACTIVE_STATUSES).toContain("cod_pending");
    expect(STATUS_LABEL.cod_pending).toContain("เก็บเงินปลายทาง");
  });

  it("checkout รับ paymentMethod + otpCode (ตัวเลข 4–8 หลัก)", () => {
    const base = {
      clientRequestId: "abcdefgh12",
      fulfillment: "delivery",
      items: [{ productId: "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", variantId: null, modifierOptionIds: [], quantity: 1 }],
      customerName: "ก",
      customerPhone: "0812345678",
    };
    expect(checkoutSchema.safeParse({ ...base, paymentMethod: "cod", otpCode: "123456" }).success).toBe(true);
    expect(checkoutSchema.safeParse({ ...base, paymentMethod: "cod", otpCode: "12ab" }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, paymentMethod: "cash" }).success).toBe(false);
  });
});

describe("R3 เก็บเงินปลายทาง — ฝั่งลูกค้า (server)", () => {
  const actions = read("src/app/s/[slug]/order/actions.ts");

  it("COD: ส่งถึงบ้านเท่านั้น + ประวัติไม่รับของ + จำนวนค้าง + เพดาน + OTP ก่อนสร้างออเดอร์", () => {
    const branch = actions.slice(actions.indexOf("const isCod = input.paymentMethod === \"cod\";"), actions.indexOf("const now = Date.now();", actions.indexOf("const isCod")));
    expect(branch).toContain('if (input.fulfillment !== "delivery")');
    expect(branch).toContain("countFailedCodOrders(");
    expect(branch).toContain("countActiveCodOrders(");
    expect(branch).toContain("if (total > cap)");
    expect(branch).toContain("verifyCodOtp(");
  });

  it("COD สร้างเป็น cod_pending ไม่สร้าง QR และแจ้งร้านทันที", () => {
    expect(actions).toContain('status: isCod ? "cod_pending" : "awaiting_payment"');
    expect(actions).toContain('payment_method: isCod ? "cod" : "beam"');
    const codReturn = actions.indexOf("if (isCod) {\n    void logSystemEvent(");
    expect(codReturn).toBeGreaterThan(0);
    expect(codReturn).toBeLessThan(actions.indexOf("const qr = await ensureQr(inserted.order);"));
    expect(read("src/modules/online-orders/notify.ts")).toContain('order.status !== "cod_pending"');
  });

  it("OTP: จำกัดความถี่ + hash + ตรวจแบบ timing-safe + ใช้ครั้งเดียว + นับครั้งผิด", () => {
    expect(actions).toContain("COD_OTP_COOLDOWN_MS");
    expect(actions).toContain("COD_OTP_MAX_PER_PHONE_DAY");
    expect(actions).toContain("COD_OTP_MAX_PER_IP_10MIN");
    expect(actions).toContain("timingSafeEqual(expected, actual)");
    expect(actions).toContain("consumeCodOtp(otp.id)");
    expect(actions).toContain("bumpCodOtpAttempts(otp.id, otp.attempts + 1)");
    expect(COD_OTP_MAX_ATTEMPTS).toBe(5);
    expect(COD_FAILED_BLOCK_COUNT).toBe(2);
  });

  it("migration: ตาราง OTP ปิดสิทธิ์ anon/authenticated + สถานะใหม่ + สวิตช์ปิด", () => {
    const sql = read("supabase/migrations/20261214120000_online_cod.sql");
    expect(sql).toContain("revoke all on public.online_order_otps from anon, authenticated;");
    expect(sql).toContain("'cod_pending', 'delivery_failed'");
    expect(sql).toContain("cod_enabled boolean not null default false");
  });
});

describe("R3 เก็บเงินปลายทาง — ฝั่งร้าน", () => {
  const actions = read("src/app/(dashboard)/website/orders/actions.ts");

  it("รับออเดอร์ COD: บิลเปิดค้าง ไม่ผูก/ปิดด้วย Beam", () => {
    expect(actions).toContain('if (order.status === "paid" || order.status === "cod_pending")');
    expect(actions).toContain('if (billRow && billRow.status !== "paid" && !isCod)');
  });

  it("สำเร็จ: โอน = ปิดบิลทันที · เงินสด = ค้างที่คนส่ง", () => {
    expect(actions).toContain('method: "bank_transfer",');
    expect(actions).toContain("patch.cod_cash_held = order.total;");
    expect(actions).toContain('if (codMethod !== "cash" && codMethod !== "bank_transfer") return { ok: false, error: "เลือกวิธีรับเงิน (เงินสด/โอน)" };');
  });

  it("ส่งไม่สำเร็จ: ยกเลิกบิลเปิดค้างก่อนเปลี่ยนสถานะ", () => {
    const failAt = actions.indexOf('if (to === "delivery_failed") {');
    expect(failAt).toBeGreaterThan(0);
    expect(actions.indexOf("voidOrder(order.orderId", failAt)).toBeGreaterThan(failAt);
    expect(failAt).toBeLessThan(actions.indexOf("const moved = await transitionOnlineOrder({ storeId: g.ctx.storeId, id, from: order.status, to"));
  });

  it("รับเงินสดคืน: ปิดบิลเงินสด (pos.use) แล้วจอง cod_settled_at แบบมีเงื่อนไข", () => {
    const settle = actions.slice(actions.indexOf("export async function settleCodCashAction"));
    expect(settle).toContain('g.resolved.can("pos.use")');
    expect(settle).toContain('method: "cash",');
    expect(settle).toContain('.is("cod_settled_at", null)');
  });

  it("POS + หน้าสั่งออนไลน์: ปุ่มรับเงินคืน + เลือกวิธีรับเงิน + ส่งไม่สำเร็จ", () => {
    for (const file of ["src/app/pos/OnlineOrderTickets.tsx", "src/app/(dashboard)/website/orders/OnlineOrdersBoard.tsx"]) {
      const src = read(file);
      expect(src).toContain("settleCodCashAction");
      expect(src).toContain("<CodCollectPicker");
      expect(src).toContain("<CodFailButton");
    }
  });

  it("COD บิลเปิดค้างเป็นเรื่องปกติ — ไม่บล็อกปุ่มสถานะ (กติกา billPending ใช้กับ Beam)", () => {
    expect(read("src/app/pos/OnlineOrderTickets.tsx")).toContain('const billPending = !isCod && order.status !== "paid" && !order.billClosed;');
  });
});
