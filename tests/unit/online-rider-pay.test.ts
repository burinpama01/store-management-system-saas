import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ONLINE_ORDER_SETTINGS, computeRiderPay, onlineOrderSettingsSchema } from "@/modules/online-orders/core";
import { ADDITION_TYPES, ADJUSTMENT_LABEL, DEDUCTION_TYPES } from "@/modules/hr/types";

const read = (p: string) => readFileSync(p, "utf8");

describe("R2 รายได้คนส่ง — สูตร", () => {
  it("10% ยอดอาหาร + ค่าส่งทั้งหมด (กติกาผู้ใช้): อาหาร 300 ค่าส่ง 30 = 60", () => {
    expect(computeRiderPay({ subtotal: 300, deliveryFee: 30, rate: 10, includeFee: true })).toBe(60);
  });
  it("ไม่รวมค่าส่ง = 10% อาหารอย่างเดียว", () => {
    expect(computeRiderPay({ subtotal: 300, deliveryFee: 30, rate: 10, includeFee: false })).toBe(30);
  });
  it("ปัด 2 ตำแหน่ง + กันค่าติดลบ/เกิน 100%", () => {
    expect(computeRiderPay({ subtotal: 123.45, deliveryFee: 0, rate: 10, includeFee: true })).toBe(12.35);
    expect(computeRiderPay({ subtotal: -5, deliveryFee: -3, rate: 10, includeFee: true })).toBe(0);
    expect(computeRiderPay({ subtotal: 100, deliveryFee: 0, rate: 500, includeFee: true })).toBe(100);
  });
  it("ค่าเริ่มต้น: ปิดทุกร้าน, 10%, รวมค่าส่ง", () => {
    expect(DEFAULT_ONLINE_ORDER_SETTINGS).toMatchObject({ riderPayEnabled: false, riderPayRate: 10, riderPayIncludeFee: true });
    expect(onlineOrderSettingsSchema.safeParse({ ...DEFAULT_ONLINE_ORDER_SETTINGS, riderPayRate: 101 }).success).toBe(false);
  });
});

describe("R2 รายได้คนส่ง — เงินเดือน", () => {
  it("delivery_pay เป็นรายการเพิ่ม ไม่ใช่รายหัก (payroll บวกเป็น bonusTotal)", () => {
    expect(DEDUCTION_TYPES).not.toContain("delivery_pay");
    expect(ADDITION_TYPES).toContain("delivery_pay");
    expect(ADJUSTMENT_LABEL.delivery_pay).toBe("ค่าส่งเดลิเวอรี่");
    expect(read("src/modules/hr/payroll.ts")).toContain("if (DEDUCTION_TYPES.includes(a.type)) deductionTotal += a.amount;\n      else bonusTotal += a.amount;");
  });
  it("สลิปแสดง delivery_pay ในรายการเพิ่ม", () => {
    expect(read("src/app/payslip/PayslipCard.tsx")).toContain("ADDITION_TYPES.includes(a.type)");
  });
  it("migration: ชนิด delivery_pay + unique online_order_id + สวิตช์ปิดเป็นค่าเริ่มต้น", () => {
    const sql = read("supabase/migrations/20261213120000_online_rider_pay.sql");
    expect(sql).toContain("'withholding_tax','delivery_pay'");
    expect(sql).toMatch(/create unique index if not exists payroll_adjustments_online_order_uidx[\s\S]*where online_order_id is not null/);
    expect(sql).toContain("rider_pay_enabled boolean not null default false");
  });
});

describe("R2 รายได้คนส่ง — action", () => {
  const actions = read("src/app/(dashboard)/website/orders/actions.ts") + " " + read("src/modules/online-orders/transition-service.ts");
  const repo = read("src/modules/online-orders/repository.ts");

  it("ออกไปส่ง (ส่งถึงบ้าน) ต้องเลือกคนส่งที่เป็นพนักงานสาขานี้ + ล็อกอัตรา/ยอด", () => {
    expect(actions).toContain('if (!riderUserId || !UUID_RE.test(riderUserId)) return { ok: false, error: "เลือกคนส่งก่อน" };');
    expect(actions).toContain("const rider = riders.find((r) => r.userId === riderUserId);");
    expect(actions).toContain("patch.rider_pay_amount = settings.riderPayEnabled");
  });

  it("สำเร็จแล้วบันทึกรายได้คนส่ง (1 ออเดอร์ 1 แถว) + log", () => {
    expect(actions).toContain('to === "completed" && order.fulfillment === "delivery" && order.riderUserId');
    expect(actions).toContain('"recordRiderPay"');
    expect(repo).toContain('type: "delivery_pay"');
    expect(repo).toContain('if (error.code === "23505") return "exists";');
  });

  it("คนส่ง = มีโปรไฟล์พนักงาน + ไม่ลาออก, คนลงเวลาอยู่ขึ้นก่อน", () => {
    expect(repo).toContain("listResignedUserIds(storeId)");
    expect(repo).toContain('.eq("status", "active")');
    expect(repo).toContain("Number(b.onShift) - Number(a.onShift)");
  });

  it("POS และหน้า สั่งออนไลน์ เปิดตัวเลือกคนส่งก่อนออกไปส่ง", () => {
    expect(read("src/app/pos/OnlineOrderTickets.tsx")).toContain("<RiderPicker");
    expect(read("src/app/(dashboard)/website/orders/OnlineOrdersBoard.tsx")).toContain("<RiderPicker");
  });
});

describe("R2 แก้ตามรีวิว", () => {
  it("ลบค่าส่งเดลิเวอรี่ที่หน้าพนักงานต้องยืนยัน", () => {
    const staff = read("src/app/(dashboard)/staff/StaffManager.tsx");
    expect(staff).toContain('a.type === "delivery_pay" &&');
    expect(staff).toContain('title: "ลบค่าส่งเดลิเวอรี่?"');
    expect(staff).not.toContain("window.confirm(");
  });
  it("บันทึกรายได้ล้ม → บอกให้เพิ่มเป็นโบนัสพร้อมรหัสออเดอร์ (ฟอร์มมือไม่มีชนิด delivery_pay)", () => {
    expect(read("src/modules/online-orders/transition-service.ts")).toContain('เป็น "โบนัส/เพิ่ม" ฿${order.riderPayAmount}');
  });
  it("online_order_id อ้างถึง online_orders (on delete set null) + type มี onlineOrderId", () => {
    expect(read("supabase/migrations/20261213120000_online_rider_pay.sql")).toContain("references public.online_orders(id) on delete set null");
    expect(read("src/modules/hr/types.ts")).toContain("onlineOrderId?: string | null;");
  });
  it("รายชื่อคนส่ง: โปรไฟล์ไม่มีชื่อใช้ชื่อบัญชี/อีเมล", () => {
    expect(read("src/modules/online-orders/repository.ts")).toContain("db.auth.admin.getUserById(userId)");
  });
});
