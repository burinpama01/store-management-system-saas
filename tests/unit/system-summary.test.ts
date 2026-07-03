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
      tenant({ plan: "starter", status: "trialing", storeCount: 1, memberCount: 2 }),
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
