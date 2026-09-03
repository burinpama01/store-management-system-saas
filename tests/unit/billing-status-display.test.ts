import { describe, expect, it } from "vitest";
import {
  daysUntil,
  describeSubscriptionDisplay,
  subscriptionStatusLabel,
} from "@/modules/billing/status-display";

const NOW = new Date("2026-09-03T00:00:00Z");

/**
 * ข้อมูลจริงจาก production ตอนที่เจอบั๊ก (2026-09-03) — ใช้เป็นกรณีทดสอบตรง ๆ
 * เพื่อไม่ให้ป้ายสถานะกลับมาแสดงสลับกันอีก
 */
describe("describeSubscriptionDisplay", () => {
  it("Each Other: สัญญาไม่มีวันหมดอายุ ต้องไม่ใช่ทดลองใช้ แม้วันที่จะเลยมาแล้ว", () => {
    const display = describeSubscriptionDisplay(
      { plan: "enterprise", isActive: true, promoTrial: false, expires: false, currentPeriodEnd: "2026-07-21T00:00:00Z" },
      NOW,
    );
    expect(display.kind).toBe("enterprise_contract");
    expect(display.daysLeft).toBeNull();
    expect(display.showExpiryDate).toBe(false);
    expect(subscriptionStatusLabel(display)).toBe("ใช้งานอยู่ · ไม่มีกำหนดหมดอายุ");
  });

  it("proud.cafe: Enterprise แบบมีกำหนด ต้องโชว์วันหมดอายุ ไม่ใช่ 'ไม่มีกำหนดหมดอายุ'", () => {
    const display = describeSubscriptionDisplay(
      { plan: "enterprise", isActive: true, promoTrial: false, expires: true, currentPeriodEnd: "2026-10-02T00:00:00Z" },
      NOW,
    );
    expect(display.kind).toBe("active");
    expect(display.showExpiryDate).toBe(true);
    expect(display.daysLeft).toBe(29);
    expect(subscriptionStatusLabel(display)).toBe("ใช้งานอยู่ · เหลือ 29 วัน");
  });

  it("SKY: โปรทดลองฟรีจริง (promo_trial_code) ขึ้นว่าทดลองใช้", () => {
    const display = describeSubscriptionDisplay(
      { plan: "enterprise", isActive: true, promoTrial: true, expires: true, currentPeriodEnd: "2026-09-24T00:00:00Z" },
      NOW,
    );
    expect(display.kind).toBe("trial");
    expect(subscriptionStatusLabel(display)).toBe("ทดลองใช้ · เหลือ 21 วัน");
  });

  it("Enterprise สัญญาที่ยังไม่เปิดสิทธิ์ ให้ไปติดต่อผู้ดูแล ไม่ใช่ให้ซื้อเอง", () => {
    const display = describeSubscriptionDisplay(
      { plan: "enterprise", isActive: false, promoTrial: false, expires: false, currentPeriodEnd: "2099-12-31T23:59:59Z" },
      NOW,
    );
    expect(display.kind).toBe("enterprise_inactive");
    expect(display.canPurchase).toBe(false);
    expect(subscriptionStatusLabel(display)).toBe("ต้องติดต่อผู้ดูแลแพลตฟอร์ม");
  });

  it("แพ็กเกจปกติที่หมดอายุ ให้ซื้อต่อได้และเห็นวันหมดอายุ", () => {
    const display = describeSubscriptionDisplay(
      { plan: "premium", isActive: false, promoTrial: false, expires: true, currentPeriodEnd: "2026-08-01T00:00:00Z" },
      NOW,
    );
    expect(display.kind).toBe("expired");
    expect(display.canPurchase).toBe(true);
    expect(display.showExpiryDate).toBe(true);
  });

  it("แพ็กเกจที่ไม่ใช่ enterprise ต้องไม่ถูกมองว่าเป็นสัญญาไม่มีวันหมด แม้ expires จะเป็น false", () => {
    const display = describeSubscriptionDisplay(
      { plan: "premium", isActive: true, promoTrial: false, expires: false, currentPeriodEnd: "2026-09-10T00:00:00Z" },
      NOW,
    );
    expect(display.kind).toBe("active");
  });
});

describe("daysUntil", () => {
  it("ปัดขึ้นและไม่ติดลบ", () => {
    expect(daysUntil("2026-09-04T12:00:00Z", NOW)).toBe(2);
    expect(daysUntil("2026-08-01T00:00:00Z", NOW)).toBe(0);
    expect(daysUntil("ไม่ใช่วันที่", NOW)).toBe(0);
  });
});
