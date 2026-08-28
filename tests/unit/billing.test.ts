import { describe, it, expect } from "vitest";
import {
  DEFAULT_BILLING_STATE,
  explainFeatureLock,
  getFeatureLimit,
  isAccessAllowed,
  getPlanFeatures,
  canUseFeature,
} from "@/modules/billing/types";
import type { BillingState, PlanFeatures } from "@/modules/billing/types";

function state(plan: BillingState["plan"], status: BillingState["status"]): BillingState {
  return {
    plan,
    status,
    currentPeriodEnd: "2030-01-01T00:00:00Z",
    cancelAtPeriodEnd: false,
    trialEnd: null,
  };
}

// Business is excluded: its features come from the tenant-selected config
// (covered in tests/unit/business-plan.test.ts).
const EXPECTED_PLAN_FEATURES: Record<Exclude<BillingState["plan"], "business">, PlanFeatures> = {
  free: {
    maxStores: 1,
    maxMembers: 1,
    groceryPos: false,
    couponManagement: false,
    loyaltyPoints: false,
    buffetManagement: false,
    stockManagement: false,
    advancedPrinting: false,
    qrOrdering: false,
    customerDisplay: false,
    offlinePos: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: false,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
    musicRequest: false,
    aiAssistant: false,
    aiVision: false,
    aiForecast: false,
  },
  starter: {
    maxStores: 1,
    maxMembers: 3,
    groceryPos: true,
    couponManagement: false,
    loyaltyPoints: false,
    buffetManagement: false,
    stockManagement: false,
    advancedPrinting: false,
    qrOrdering: false,
    customerDisplay: false,
    offlinePos: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: false,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
    musicRequest: false,
    aiAssistant: false,
    aiVision: false,
    aiForecast: false,
  },
  standard: {
    maxStores: 3,
    maxMembers: 10,
    groceryPos: true,
    couponManagement: false,
    loyaltyPoints: false,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: false,
    customerDisplay: false,
    offlinePos: false,
    lineNotify: false,
    attendanceGps: false,
    advancedReports: true,
    advancedPermissions: false,
    multiBranchReporting: false,
    apiIntegration: false,
    musicRequest: false,
    aiAssistant: false,
    aiVision: false,
    aiForecast: false,
  },
  premium: {
    maxStores: 5,
    maxMembers: 50,
    groceryPos: true,
    couponManagement: true,
    loyaltyPoints: true,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: true,
    customerDisplay: false,
    offlinePos: true,
    lineNotify: true,
    attendanceGps: true,
    advancedReports: true,
    advancedPermissions: true,
    multiBranchReporting: false,
    apiIntegration: false,
    musicRequest: false,
    aiAssistant: false,
    aiVision: false,
    aiForecast: false,
  },
  enterprise: {
    maxStores: Infinity,
    maxMembers: Infinity,
    groceryPos: true,
    couponManagement: true,
    loyaltyPoints: true,
    buffetManagement: true,
    stockManagement: true,
    advancedPrinting: true,
    qrOrdering: true,
    customerDisplay: true,
    offlinePos: true,
    lineNotify: true,
    attendanceGps: true,
    advancedReports: true,
    advancedPermissions: true,
    multiBranchReporting: true,
    apiIntegration: true,
    musicRequest: true,
    aiAssistant: true,
    aiVision: true,
    aiForecast: true,
  },
};

describe("isAccessAllowed", () => {
  it("allows active", () => {
    expect(isAccessAllowed(state("starter", "active"))).toBe(true);
  });
  it("allows trialing", () => {
    expect(isAccessAllowed(state("premium", "trialing"))).toBe(true);
  });
  it("allows past_due (grace period)", () => {
    expect(isAccessAllowed(state("standard", "past_due"))).toBe(true);
  });
  it("blocks incomplete", () => {
    expect(isAccessAllowed(state("starter", "incomplete"))).toBe(false);
  });
  it("blocks incomplete_expired", () => {
    expect(isAccessAllowed(state("premium", "incomplete_expired"))).toBe(false);
  });
  it("blocks unpaid", () => {
    expect(isAccessAllowed(state("standard", "unpaid"))).toBe(false);
  });
  it("blocks canceled", () => {
    expect(isAccessAllowed(state("enterprise", "canceled"))).toBe(false);
  });
  it("blocks paused", () => {
    expect(isAccessAllowed(state("premium", "paused"))).toBe(false);
  });
});

describe("getPlanFeatures — free degraded when blocked", () => {
  it("canceled state returns free features regardless of plan", () => {
    const features = getPlanFeatures(state("premium", "canceled"));
    expect(features.qrOrdering).toBe(false);
    expect(features.maxStores).toBe(1);
  });
  it("active premium returns premium features", () => {
    const features = getPlanFeatures(state("premium", "active"));
    expect(features.qrOrdering).toBe(true);
    expect(features.attendanceGps).toBe(true);
    expect(features.maxStores).toBe(5);
  });
});

describe("getPlanFeatures — expired paid window degrades to free (public surfaces)", () => {
  const expired = (plan: BillingState["plan"]): BillingState => ({
    ...state(plan, "active"),
    currentPeriodEnd: "2020-01-01T00:00:00Z",
  });

  it.each(["starter", "standard", "premium"] as const)(
    "expired %s with active status returns free features (QR/player/API locked)",
    (plan) => {
      const features = getPlanFeatures(expired(plan));
      expect(features).toEqual(getPlanFeatures(state("free", "active")));
      expect(features.qrOrdering).toBe(false);
      expect(features.musicRequest).toBe(false);
      expect(features.apiIntegration).toBe(false);
    },
  );

  it("expired business ignores the stored config", () => {
    const features = getPlanFeatures({
      ...expired("business"),
      business: { seats: 9, stores: 3, features: ["qrOrdering", "musicRequest"] },
    });
    expect(features.qrOrdering).toBe(false);
    expect(features.musicRequest).toBe(false);
    expect(features.maxMembers).toBe(1);
  });

  it("enterprise has no expiry window", () => {
    expect(getPlanFeatures(expired("enterprise")).qrOrdering).toBe(true);
  });

  it("a still-current window keeps features (explicit now)", () => {
    const s = { ...state("premium", "active"), currentPeriodEnd: "2026-08-01T00:00:00Z" };
    expect(getPlanFeatures(s, new Date("2026-07-03T00:00:00Z")).qrOrdering).toBe(true);
    expect(getPlanFeatures(s, new Date("2026-08-02T00:00:00Z")).qrOrdering).toBe(false);
  });

  it("free plan is unaffected by the expiry check", () => {
    expect(getPlanFeatures(expired("free"))).toEqual(getPlanFeatures(state("free", "active")));
  });
});

describe("getPlanFeatures — package matrix contract", () => {
  it.each(Object.entries(EXPECTED_PLAN_FEATURES))("%s matches the package feature matrix", (plan, expected) => {
    expect(getPlanFeatures(state(plan as BillingState["plan"], "active"))).toEqual(expected);
  });
});

describe("canUseFeature — plan tiers", () => {
  it("free: no buffet, no qr, no advanced printing", () => {
    const s = state("free", "active");
    expect(canUseFeature(s, "groceryPos")).toBe(false);
    expect(canUseFeature(s, "buffetManagement")).toBe(false);
    expect(canUseFeature(s, "qrOrdering")).toBe(false);
    expect(canUseFeature(s, "advancedPrinting")).toBe(false);
  });
  it("starter: no buffet, no qr", () => {
    const s = state("starter", "active");
    expect(canUseFeature(s, "groceryPos")).toBe(true);
    expect(canUseFeature(s, "couponManagement")).toBe(false);
    expect(canUseFeature(s, "buffetManagement")).toBe(false);
    expect(canUseFeature(s, "qrOrdering")).toBe(false);
  });
  it("standard: buffet yes but member commerce and qr/display no", () => {
    const s = state("standard", "active");
    expect(canUseFeature(s, "couponManagement")).toBe(false);
    expect(canUseFeature(s, "loyaltyPoints")).toBe(false);
    expect(canUseFeature(s, "buffetManagement")).toBe(true);
    expect(canUseFeature(s, "stockManagement")).toBe(true);
    expect(canUseFeature(s, "qrOrdering")).toBe(false);
    expect(canUseFeature(s, "customerDisplay")).toBe(false);
  });
  it("premium: qr + gps + coupon/loyalty but no display/multi-branch", () => {
    const s = state("premium", "active");
    expect(canUseFeature(s, "qrOrdering")).toBe(true);
    expect(canUseFeature(s, "couponManagement")).toBe(true);
    expect(canUseFeature(s, "loyaltyPoints")).toBe(true);
    expect(canUseFeature(s, "customerDisplay")).toBe(false);
    expect(canUseFeature(s, "offlinePos")).toBe(true);
    expect(canUseFeature(s, "attendanceGps")).toBe(true);
    expect(canUseFeature(s, "lineNotify")).toBe(true);
    expect(canUseFeature(s, "multiBranchReporting")).toBe(false);
  });
  it("enterprise: all features including multi-branch", () => {
    const s = state("enterprise", "active");
    expect(canUseFeature(s, "couponManagement")).toBe(true);
    expect(canUseFeature(s, "loyaltyPoints")).toBe(true);
    expect(canUseFeature(s, "customerDisplay")).toBe(true);
    expect(canUseFeature(s, "multiBranchReporting")).toBe(true);
    expect(canUseFeature(s, "apiIntegration")).toBe(true);
  });
  it("maxStores is > 0 from the numeric path", () => {
    expect(canUseFeature(state("free", "active"), "maxStores")).toBe(true);
    expect(canUseFeature(state("free", "active"), "maxMembers")).toBe(true);
  });
  it("trialing premium has premium features", () => {
    const s = state("premium", "trialing");
    expect(canUseFeature(s, "qrOrdering")).toBe(true);
  });
  it("past_due standard still has standard features", () => {
    const s = state("standard", "past_due");
    expect(canUseFeature(s, "buffetManagement")).toBe(true);
  });
});

describe("musicRequest — Enterprise only", () => {
  it("is enabled only for enterprise plan", () => {
    expect(canUseFeature(state("free", "active"), "musicRequest")).toBe(false);
    expect(canUseFeature(state("starter", "active"), "musicRequest")).toBe(false);
    expect(canUseFeature(state("standard", "active"), "musicRequest")).toBe(false);
    expect(canUseFeature(state("premium", "active"), "musicRequest")).toBe(false);
    expect(canUseFeature(state("enterprise", "active"), "musicRequest")).toBe(true);
  });
  it("degrades to locked when enterprise billing is blocked", () => {
    expect(canUseFeature(state("enterprise", "canceled"), "musicRequest")).toBe(false);
  });
  it("has a Thai feature label", () => {
    expect(explainFeatureLock(state("premium", "active"), "musicRequest")).toContain("Premium");
    expect(explainFeatureLock(state("enterprise", "active"), "musicRequest")).toBeNull();
  });
});

describe("feature labels and limits", () => {
  it("free default state keeps basic access available", () => {
    expect(DEFAULT_BILLING_STATE.plan).toBe("free");
    expect(canUseFeature(DEFAULT_BILLING_STATE, "maxStores")).toBe(true);
  });

  it("returns numeric package limits by plan", () => {
    expect(getFeatureLimit(state("free", "active"), "maxStores")).toBe(1);
    expect(getFeatureLimit(state("free", "active"), "maxMembers")).toBe(1);
    expect(getFeatureLimit(state("starter", "active"), "maxStores")).toBe(1);
    expect(getFeatureLimit(state("starter", "active"), "maxMembers")).toBe(3);
    expect(getFeatureLimit(state("standard", "active"), "maxStores")).toBe(3);
    expect(getFeatureLimit(state("standard", "active"), "maxMembers")).toBe(10);
    expect(getFeatureLimit(state("premium", "active"), "maxStores")).toBe(5);
    expect(getFeatureLimit(state("premium", "active"), "maxMembers")).toBe(50);
    expect(getFeatureLimit(state("enterprise", "active"), "maxStores")).toBe(Infinity);
    expect(getFeatureLimit(state("enterprise", "active"), "maxMembers")).toBe(Infinity);
  });

  it("explains locked features for current package", () => {
    expect(explainFeatureLock(state("free", "active"), "qrOrdering")).toContain("Free");
    expect(explainFeatureLock(state("premium", "active"), "qrOrdering")).toBeNull();
    expect(explainFeatureLock(state("free", "active"), "maxStores")).toBeNull();
  });
});
