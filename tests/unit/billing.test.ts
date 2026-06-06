import { describe, it, expect } from "vitest";
import {
  DEFAULT_BILLING_STATE,
  explainFeatureLock,
  getFeatureLimit,
  isAccessAllowed,
  getPlanFeatures,
  canUseFeature,
} from "@/modules/billing/types";
import type { BillingState } from "@/modules/billing/types";

function state(plan: BillingState["plan"], status: BillingState["status"]): BillingState {
  return {
    plan,
    status,
    currentPeriodEnd: "2030-01-01T00:00:00Z",
    cancelAtPeriodEnd: false,
    trialEnd: null,
  };
}

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
    expect(features.maxStores).toBe(10);
  });
});

describe("canUseFeature — plan tiers", () => {
  it("free: no buffet, no qr, no advanced printing", () => {
    const s = state("free", "active");
    expect(canUseFeature(s, "buffetManagement")).toBe(false);
    expect(canUseFeature(s, "qrOrdering")).toBe(false);
    expect(canUseFeature(s, "advancedPrinting")).toBe(false);
  });
  it("starter: no buffet, no qr", () => {
    const s = state("starter", "active");
    expect(canUseFeature(s, "buffetManagement")).toBe(false);
    expect(canUseFeature(s, "qrOrdering")).toBe(false);
  });
  it("standard: buffet yes, qr no", () => {
    const s = state("standard", "active");
    expect(canUseFeature(s, "buffetManagement")).toBe(true);
    expect(canUseFeature(s, "stockManagement")).toBe(true);
    expect(canUseFeature(s, "qrOrdering")).toBe(false);
  });
  it("premium: all features including qr + gps", () => {
    const s = state("premium", "active");
    expect(canUseFeature(s, "qrOrdering")).toBe(true);
    expect(canUseFeature(s, "attendanceGps")).toBe(true);
    expect(canUseFeature(s, "lineNotify")).toBe(true);
    expect(canUseFeature(s, "multiBranchReporting")).toBe(false);
  });
  it("enterprise: all features including multi-branch", () => {
    const s = state("enterprise", "active");
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

describe("feature labels and limits", () => {
  it("free default state keeps basic access available", () => {
    expect(DEFAULT_BILLING_STATE.plan).toBe("free");
    expect(canUseFeature(DEFAULT_BILLING_STATE, "maxStores")).toBe(true);
  });

  it("returns numeric package limits", () => {
    expect(getFeatureLimit(state("free", "active"), "maxStores")).toBe(1);
    expect(getFeatureLimit(state("premium", "active"), "maxMembers")).toBe(100);
  });

  it("explains locked features for current package", () => {
    expect(explainFeatureLock(state("free", "active"), "qrOrdering")).toContain("Free");
    expect(explainFeatureLock(state("premium", "active"), "qrOrdering")).toBeNull();
    expect(explainFeatureLock(state("free", "active"), "maxStores")).toBeNull();
  });
});
