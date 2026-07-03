import { describe, it, expect } from "vitest";
import {
  BUSINESS_COMPONENTS,
  BUSINESS_DEFAULT_PRICES,
  BUSINESS_LIMITS,
  computeBusinessPrice,
  computeBusinessStartingPrice,
  isBusinessComponent,
  normalizeBusinessConfig,
  parseBusinessConfigJson,
} from "@/modules/billing/business-plan";
import {
  BUSINESS_SELECTABLE_FEATURES,
  businessConfigToPlanFeatures,
  getPlanFeatures,
  type BillingState,
  type BusinessPlanConfig,
} from "@/modules/billing/types";
import { hasBillingAccess } from "@/modules/billing/pricing";

function businessState(
  config: BusinessPlanConfig | null,
  overrides: Partial<BillingState> = {},
): BillingState {
  return {
    plan: "business",
    status: "active",
    currentPeriodEnd: "2030-01-01T00:00:00Z",
    cancelAtPeriodEnd: false,
    trialEnd: null,
    business: config,
    ...overrides,
  };
}

describe("computeBusinessPrice", () => {
  it("sums base + seats + stores + selected features", () => {
    const config: BusinessPlanConfig = {
      seats: 5,
      stores: 2,
      features: ["qrOrdering", "stockManagement"],
    };
    // 300 + 5×50 + 2×200 + 300 + 150 = 1400
    expect(computeBusinessPrice(config, BUSINESS_DEFAULT_PRICES, "30d")).toBe(1400);
  });

  it("1y prices are the monthly component × 10 by default", () => {
    const config: BusinessPlanConfig = { seats: 1, stores: 1, features: [] };
    const monthly = computeBusinessPrice(config, BUSINESS_DEFAULT_PRICES, "30d");
    expect(computeBusinessPrice(config, BUSINESS_DEFAULT_PRICES, "1y")).toBe(monthly * 10);
  });

  it("starting price is 1 seat + 1 store + no features", () => {
    // 300 + 50 + 200 = 550
    expect(computeBusinessStartingPrice(BUSINESS_DEFAULT_PRICES, "30d")).toBe(550);
  });

  it("every selectable feature has a component price", () => {
    for (const key of BUSINESS_SELECTABLE_FEATURES) {
      expect(isBusinessComponent(key)).toBe(true);
      expect(BUSINESS_DEFAULT_PRICES[key]["30d"]).toBeGreaterThan(0);
    }
    expect(BUSINESS_COMPONENTS).toContain("base");
    expect(BUSINESS_COMPONENTS).toContain("perSeat");
    expect(BUSINESS_COMPONENTS).toContain("perStore");
  });
});

describe("normalizeBusinessConfig", () => {
  it("clamps seats and stores into limits", () => {
    const config = normalizeBusinessConfig({ seats: 99999, stores: 0, features: [] });
    expect(config).toEqual({
      seats: BUSINESS_LIMITS.seats.max,
      stores: BUSINESS_LIMITS.stores.min,
      features: [],
    });
  });

  it("drops unknown feature keys and keeps valid ones", () => {
    const config = normalizeBusinessConfig({
      seats: 3,
      stores: 1,
      features: ["qrOrdering", "notAFeature", "maxStores"],
    });
    expect(config?.features).toEqual(["qrOrdering"]);
  });

  it("rejects missing counts", () => {
    expect(normalizeBusinessConfig({ features: ["qrOrdering"] })).toBeNull();
    expect(normalizeBusinessConfig({ seats: "abc", stores: 1 })).toBeNull();
  });

  it("accepts numeric strings from form transport", () => {
    const config = normalizeBusinessConfig({ seats: "7", stores: "2", features: [] });
    expect(config).toEqual({ seats: 7, stores: 2, features: [] });
  });
});

describe("parseBusinessConfigJson", () => {
  it("parses a valid JSON payload", () => {
    const raw = JSON.stringify({ seats: 4, stores: 2, features: ["lineNotify"] });
    expect(parseBusinessConfigJson(raw)).toEqual({ seats: 4, stores: 2, features: ["lineNotify"] });
  });

  it("returns null for malformed input", () => {
    expect(parseBusinessConfigJson("not json")).toBeNull();
    expect(parseBusinessConfigJson("")).toBeNull();
    expect(parseBusinessConfigJson(null)).toBeNull();
    expect(parseBusinessConfigJson(JSON.stringify(["array"]))).toBeNull();
  });
});

describe("business plan features", () => {
  it("unlocks exactly the selected features + chosen limits", () => {
    const features = businessConfigToPlanFeatures({
      seats: 8,
      stores: 3,
      features: ["qrOrdering", "couponManagement"],
    });
    expect(features.maxMembers).toBe(8);
    expect(features.maxStores).toBe(3);
    expect(features.qrOrdering).toBe(true);
    expect(features.couponManagement).toBe(true);
    expect(features.loyaltyPoints).toBe(false);
    expect(features.apiIntegration).toBe(false);
  });

  it("getPlanFeatures uses the stored config for active business plans", () => {
    const s = businessState({ seats: 2, stores: 1, features: ["stockManagement"] });
    const features = getPlanFeatures(s);
    expect(features.stockManagement).toBe(true);
    expect(features.maxMembers).toBe(2);
    expect(features.qrOrdering).toBe(false);
  });

  it("business without a stored config degrades to free features", () => {
    const features = getPlanFeatures(businessState(null));
    expect(features.maxMembers).toBe(1);
    expect(features.stockManagement).toBe(false);
  });

  it("canceled business returns free features regardless of config", () => {
    const s = businessState(
      { seats: 9, stores: 5, features: ["qrOrdering"] },
      { status: "canceled" },
    );
    expect(getPlanFeatures(s).qrOrdering).toBe(false);
  });
});

describe("hasBillingAccess — business", () => {
  it("allows an active business plan inside the paid window", () => {
    expect(hasBillingAccess(businessState({ seats: 1, stores: 1, features: [] }))).toBe(true);
  });

  it("blocks an expired business plan", () => {
    const s = businessState(
      { seats: 1, stores: 1, features: [] },
      { currentPeriodEnd: "2020-01-01T00:00:00Z" },
    );
    expect(hasBillingAccess(s)).toBe(false);
  });
});
