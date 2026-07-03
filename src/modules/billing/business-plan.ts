import type { BillingDuration } from "./pricing";
import {
  BUSINESS_SELECTABLE_FEATURES,
  FEATURE_LABELS,
  type BusinessPlanConfig,
  type FeatureKey,
} from "./types";

/**
 * Business (build-your-own) plan: the tenant picks seats, stores and individual
 * features; the price is the sum of the selected components. Component prices
 * are super-admin editable (business_plan_prices), these are the seeded defaults.
 */

export type BusinessFeatureComponent = Exclude<FeatureKey, "maxStores" | "maxMembers">;
export type BusinessComponent = "base" | "perSeat" | "perStore" | BusinessFeatureComponent;

export const BUSINESS_COMPONENTS: BusinessComponent[] = [
  "base",
  "perSeat",
  "perStore",
  ...BUSINESS_SELECTABLE_FEATURES,
];

export function isBusinessComponent(value: string): value is BusinessComponent {
  return (BUSINESS_COMPONENTS as string[]).includes(value);
}

export const BUSINESS_COMPONENT_LABELS: Record<BusinessComponent, string> = {
  base: "ค่าระบบพื้นฐาน",
  perSeat: "ต่อที่นั่ง (สมาชิก)",
  perStore: "ต่อสาขา",
  ...(Object.fromEntries(
    BUSINESS_SELECTABLE_FEATURES.map((key) => [key, FEATURE_LABELS[key]]),
  ) as Record<BusinessFeatureComponent, string>),
};

export type BusinessPriceMap = Record<BusinessComponent, Record<BillingDuration, number>>;

/** Default component prices in THB. 1-year = monthly × 10 (≈2 months free). */
export const BUSINESS_DEFAULT_PRICES: BusinessPriceMap = buildDefaultPrices();

function buildDefaultPrices(): BusinessPriceMap {
  const monthly: Record<BusinessComponent, number> = {
    base: 300,
    perSeat: 50,
    perStore: 200,
    groceryPos: 100,
    couponManagement: 100,
    loyaltyPoints: 100,
    buffetManagement: 150,
    stockManagement: 150,
    advancedPrinting: 100,
    qrOrdering: 300,
    customerDisplay: 100,
    offlinePos: 150,
    lineNotify: 100,
    attendanceGps: 100,
    advancedReports: 150,
    advancedPermissions: 100,
    multiBranchReporting: 200,
    apiIntegration: 300,
    musicRequest: 200,
  };
  return Object.fromEntries(
    (Object.entries(monthly) as [BusinessComponent, number][]).map(([key, amount]) => [
      key,
      { "30d": amount, "1y": amount * 10 },
    ]),
  ) as BusinessPriceMap;
}

export const BUSINESS_LIMITS = {
  seats: { min: 1, max: 500 },
  stores: { min: 1, max: 50 },
} as const;

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  return Math.min(max, Math.max(min, i));
}

/**
 * Validates + clamps an untrusted config. Returns null when the shape is
 * unusable (missing counts); unknown feature keys are dropped, duplicates deduped.
 */
export function normalizeBusinessConfig(input: {
  seats?: unknown;
  stores?: unknown;
  features?: unknown;
}): BusinessPlanConfig | null {
  const seats = clampInt(input.seats, BUSINESS_LIMITS.seats.min, BUSINESS_LIMITS.seats.max);
  const stores = clampInt(input.stores, BUSINESS_LIMITS.stores.min, BUSINESS_LIMITS.stores.max);
  if (seats == null || stores == null) return null;
  const rawFeatures = Array.isArray(input.features) ? input.features : [];
  const features = BUSINESS_SELECTABLE_FEATURES.filter((key) => rawFeatures.includes(key));
  return { seats, stores, features };
}

/** Parses a JSON-transported config (form/action payload). Null when invalid. */
export function parseBusinessConfigJson(raw: unknown): BusinessPlanConfig | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeBusinessConfig(parsed);
  } catch {
    return null;
  }
}

/** Total price of a Business config for a duration (pure). */
export function computeBusinessPrice(
  config: BusinessPlanConfig,
  prices: BusinessPriceMap,
  duration: BillingDuration,
): number {
  let total =
    prices.base[duration] +
    prices.perSeat[duration] * config.seats +
    prices.perStore[duration] * config.stores;
  for (const key of config.features) {
    if (isBusinessComponent(key)) total += prices[key][duration];
  }
  return Math.round(total);
}

/** Cheapest possible Business price (1 seat, 1 store, no features) for landing. */
export function computeBusinessStartingPrice(
  prices: BusinessPriceMap,
  duration: BillingDuration,
): number {
  return computeBusinessPrice({ seats: 1, stores: 1, features: [] }, prices, duration);
}

/** Short Thai summary of a config, e.g. for the current-plan panel. */
export function describeBusinessConfig(config: BusinessPlanConfig): string {
  return `${config.stores} สาขา / ${config.seats} ที่นั่ง / ${config.features.length} ฟีเจอร์`;
}
