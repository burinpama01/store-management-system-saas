import { describe, it, expect } from "vitest";
import {
  summarizeTenants,
  planTenantSuspension,
  summarizePayments,
  type TenantOverview,
} from "@/modules/system/repository";

function tenant(overrides: Partial<TenantOverview>): TenantOverview {
  return {
    organizationId: "org-1",
    name: "Org",
    slug: "org",
    ownerId: "user-1",
    plan: "free",
    status: "active",
    storeCount: 1,
    memberCount: 1,
    suspended: false,
    createdAt: "2026-01-01T00:00:00Z",
    currentPeriodEnd: null,
    promoTrial: false,
    expires: false,
    ...overrides,
  };
}

describe("summarizeTenants", () => {
  it("returns zeroed summary for empty input", () => {
    const summary = summarizeTenants([]);
    expect(summary.totalTenants).toBe(0);
    expect(summary.totalStores).toBe(0);
    expect(summary.totalMembers).toBe(0);
    expect(summary.byPlan).toEqual({
      free: 0,
      starter: 0,
      standard: 0,
      premium: 0,
      business: 0,
      enterprise: 0,
    });
  });

  it("aggregates counts, plans, and risk states", () => {
    const summary = summarizeTenants([
      tenant({ plan: "premium", status: "active", storeCount: 3, memberCount: 10 }),
      tenant({ plan: "starter", status: "trialing", promoTrial: true, expires: true, currentPeriodEnd: "2099-01-01T00:00:00Z", storeCount: 1, memberCount: 2 }),
      tenant({ plan: "standard", status: "past_due", storeCount: 2, memberCount: 5 }),
      tenant({ plan: "free", status: "unpaid", storeCount: 1, memberCount: 1 }),
    ]);

    expect(summary.totalTenants).toBe(4);
    expect(summary.totalStores).toBe(7);
    expect(summary.totalMembers).toBe(18);
    expect(summary.byPlan.premium).toBe(1);
    expect(summary.byPlan.starter).toBe(1);
    expect(summary.byPlan.standard).toBe(1);
    expect(summary.byPlan.free).toBe(1);
    expect(summary.trialingCount).toBe(1);
    expect(summary.pastDueCount).toBe(2); // past_due + unpaid
  });

  // บั๊กที่เจอบน prod 2026-09-03: 8 แถวค้าง status='trialing' จากแคมเปญเก่าทั้งที่ไม่ใช่โปรทดลอง
  // ทำให้หน้าซูเปอร์แอดมินนับผิด และหน้าแพ็กเกจของร้านขึ้นว่า "ทดลองใช้ เหลือ 0 วัน"
  it("ไม่นับ status='trialing' ที่ค้างจากข้อมูลเก่าว่าเป็นโปรทดลอง", () => {
    const summary = summarizeTenants([
      tenant({ plan: "premium", status: "trialing", promoTrial: false }),
      tenant({ plan: "enterprise", status: "trialing", promoTrial: true, expires: true, currentPeriodEnd: "2099-01-01T00:00:00Z" }),
    ]);
    expect(summary.trialingCount).toBe(1);
  });

  it("นับร้านที่หมดอายุแล้วและที่ใกล้หมดใน 7 วัน", () => {
    const now = Date.now();
    const iso = (days: number) => new Date(now + days * 86_400_000).toISOString();
    const summary = summarizeTenants([
      tenant({ plan: "premium", expires: true, currentPeriodEnd: iso(-10) }),
      tenant({ plan: "premium", expires: true, currentPeriodEnd: iso(-1) }),
      tenant({ plan: "starter", expires: true, currentPeriodEnd: iso(3) }),
      tenant({ plan: "starter", expires: true, currentPeriodEnd: iso(20) }),
      // สัญญาไม่มีวันหมดอายุต้องไม่ถูกนับว่าหมดอายุ แม้ currentPeriodEnd จะเป็นอดีต
      tenant({ plan: "enterprise", expires: false, currentPeriodEnd: null }),
    ]);
    expect(summary.expiredCount).toBe(2);
    expect(summary.expiringSoonCount).toBe(1);
  });
});

describe("summarizePayments", () => {
  const now = new Date("2026-06-15T00:00:00Z");

  it("returns zeros for no payments", () => {
    expect(summarizePayments([], now)).toEqual({ total: 0, thisMonth: 0, count: 0 });
  });

  it("sums total and current-month amounts", () => {
    const rows = [
      { amount: 690, verifiedAt: "2026-06-06T10:00:00Z" }, // this month
      { amount: 1290, verifiedAt: "2026-06-20T10:00:00Z" }, // this month
      { amount: 2290, verifiedAt: "2026-05-30T10:00:00Z" }, // last month
      { amount: 500, verifiedAt: null }, // counts to total only
    ];
    const r = summarizePayments(rows, now);
    expect(r.total).toBe(4770);
    expect(r.thisMonth).toBe(1980);
    expect(r.count).toBe(4);
  });
});

describe("planTenantSuspension", () => {
  const now = "2026-06-06T00:00:00Z";

  it("suspending sets timestamp, cancels subscription, logs suspend", () => {
    expect(planTenantSuspension(true, now)).toEqual({
      suspendedAt: now,
      subscriptionStatus: "canceled",
      auditAction: "tenant.suspend",
    });
  });

  it("unsuspending clears timestamp, leaves subscription, logs unsuspend", () => {
    expect(planTenantSuspension(false, now)).toEqual({
      suspendedAt: null,
      subscriptionStatus: null,
      auditAction: "tenant.unsuspend",
    });
  });
});
