import { describe, expect, it } from "vitest";
import {
  alertIdempotencyKey,
  buildAdminDigest,
  buildTenantAlertCopy,
  daysRemaining,
  pickAlertStage,
  planSubscriptionAlerts,
  type WatchedSubscription,
} from "@/modules/billing/subscription-watch";

const NOW = new Date("2026-09-03T00:00:00Z");

function sub(overrides: Partial<WatchedSubscription> = {}): WatchedSubscription {
  return {
    organizationId: "org-1",
    organizationName: "ร้านทดสอบ",
    plan: "premium",
    expires: true,
    promoTrial: false,
    currentPeriodEnd: "2026-09-10T00:00:00Z",
    suspended: false,
    ...overrides,
  };
}

describe("pickAlertStage", () => {
  it("เตือนเมื่อเหลือ 7 / 3 / 1 วันพอดี", () => {
    expect(pickAlertStage(sub({ currentPeriodEnd: "2026-09-10T00:00:00Z" }), NOW)?.stage).toBe("d7");
    expect(pickAlertStage(sub({ currentPeriodEnd: "2026-09-06T00:00:00Z" }), NOW)?.stage).toBe("d3");
    expect(pickAlertStage(sub({ currentPeriodEnd: "2026-09-04T00:00:00Z" }), NOW)?.stage).toBe("d1");
  });

  it("ไม่เตือนวันอื่นเพื่อไม่ให้รบกวนทุกวัน", () => {
    for (const end of ["2026-09-05T00:00:00Z", "2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z", "2026-09-09T00:00:00Z"]) {
      expect(pickAlertStage(sub({ currentPeriodEnd: end }), NOW)).toBeNull();
    }
  });

  it("เตือนว่าหมดอายุแล้วเมื่อเลยวันมาแล้ว", () => {
    const alert = pickAlertStage(sub({ currentPeriodEnd: "2026-08-01T00:00:00Z" }), NOW);
    expect(alert?.stage).toBe("expired");
    expect(alert?.daysLeft).toBe(0);
  });

  // กันบั๊กเดิมซ้ำ: Each Other มี current_period_end เป็นอดีตแต่เป็นสัญญาไม่มีวันหมดอายุ
  it("สัญญาไม่มีวันหมดอายุต้องไม่ถูกเตือน แม้วันที่จะเลยมาแล้ว", () => {
    expect(pickAlertStage(sub({ expires: false, currentPeriodEnd: "2026-07-21T00:00:00Z" }), NOW)).toBeNull();
  });

  it("ร้านที่ถูกระงับและร้านที่ไม่มีวันหมด ไม่ต้องเตือน", () => {
    expect(pickAlertStage(sub({ suspended: true }), NOW)).toBeNull();
    expect(pickAlertStage(sub({ currentPeriodEnd: null }), NOW)).toBeNull();
    expect(pickAlertStage(sub({ currentPeriodEnd: "ไม่ใช่วันที่" }), NOW)).toBeNull();
  });
});

describe("planSubscriptionAlerts", () => {
  it("เรียงเรื่องด่วนที่สุดขึ้นก่อน และข้ามรายที่ยังไม่ถึงกำหนดเตือน", () => {
    const alerts = planSubscriptionAlerts(
      [
        sub({ organizationId: "a", currentPeriodEnd: "2026-09-10T00:00:00Z" }), // d7
        sub({ organizationId: "b", currentPeriodEnd: "2026-08-01T00:00:00Z" }), // expired
        sub({ organizationId: "c", currentPeriodEnd: "2026-09-08T00:00:00Z" }), // ไม่เตือน
        sub({ organizationId: "d", currentPeriodEnd: "2026-09-04T00:00:00Z" }), // d1
      ],
      NOW,
    );
    expect(alerts.map((a) => a.organizationId)).toEqual(["b", "d", "a"]);
  });

  it("คืนรายการว่างเมื่อไม่มีอะไรต้องเตือน", () => {
    expect(planSubscriptionAlerts([], NOW)).toEqual([]);
  });
});

describe("alertIdempotencyKey", () => {
  it("หนึ่งองค์กร หนึ่งขั้น หนึ่งวัน ได้กุญแจเดียวกันเสมอ", () => {
    const alert = pickAlertStage(sub(), NOW)!;
    expect(alertIdempotencyKey(alert, "2026-09-03")).toBe("org-1:d7:2026-09-03");
    expect(alertIdempotencyKey(alert, "2026-09-04")).not.toBe(alertIdempotencyKey(alert, "2026-09-03"));
  });
});

describe("buildTenantAlertCopy", () => {
  it("แยกคำระหว่างโปรทดลองกับแพ็กเกจที่ซื้อแล้ว", () => {
    const trial = buildTenantAlertCopy(pickAlertStage(sub({ promoTrial: true }), NOW)!);
    expect(trial.title).toContain("สิทธิ์ทดลองใช้ฟรี");
    const paid = buildTenantAlertCopy(pickAlertStage(sub({ promoTrial: false }), NOW)!);
    expect(paid.title).toContain("แพ็กเกจ");
    expect(paid.title).not.toContain("ทดลอง");
  });

  it("ข้อความหมดอายุบอกผลที่ตามมาและทางแก้", () => {
    const copy = buildTenantAlertCopy(pickAlertStage(sub({ currentPeriodEnd: "2026-08-01T00:00:00Z" }), NOW)!);
    expect(copy.title).toContain("หมดอายุแล้ว");
    expect(copy.message).toContain("ตั้งค่า > แพ็กเกจ");
  });
});

describe("buildAdminDigest", () => {
  it("บอกจำนวนและแยกกลุ่มหมดแล้ว/ใกล้หมด", () => {
    const alerts = planSubscriptionAlerts(
      [
        sub({ organizationId: "a", organizationName: "ร้าน ก", currentPeriodEnd: "2026-08-01T00:00:00Z" }),
        sub({ organizationId: "b", organizationName: "ร้าน ข", currentPeriodEnd: "2026-09-10T00:00:00Z" }),
      ],
      NOW,
    );
    const digest = buildAdminDigest(alerts, "2026-09-03");
    expect(digest).toContain("หมดอายุแล้ว 1 ร้าน");
    expect(digest).toContain("ใกล้หมด 1 ร้าน");
    expect(digest).toContain("ร้าน ก");
    expect(digest).toContain("ร้าน ข");
  });

  it("บอกชัดเมื่อไม่มีอะไรต้องตาม", () => {
    expect(buildAdminDigest([], "2026-09-03")).toContain("ไม่มีร้านที่ใกล้หมดอายุ");
  });
});

describe("daysRemaining", () => {
  it("ปัดขึ้นและติดลบได้เมื่อเลยกำหนด", () => {
    expect(daysRemaining("2026-09-10T00:00:00Z", NOW)).toBe(7);
    expect(daysRemaining("2026-09-02T00:00:00Z", NOW)).toBe(-1);
    expect(Number.isNaN(daysRemaining("พัง", NOW))).toBe(true);
  });
});
