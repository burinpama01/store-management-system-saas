import { isAccessAllowed, type BillingPlan, type BillingState } from "./types";

export type BillingDuration = "30d" | "1y";

export const DURATION_DAYS: Record<BillingDuration, number> = {
  "30d": 30,
  "1y": 365,
};

export const DURATION_LABELS: Record<BillingDuration, string> = {
  "30d": "30 วัน",
  "1y": "1 ปี",
};

/** Tiers that can be purchased via PromptPay (free has no price; enterprise is custom). */
export type PaidTier = Extract<BillingPlan, "starter" | "standard" | "premium">;

export const PAID_TIERS: PaidTier[] = ["starter", "standard", "premium"];

/**
 * Default subscription prices in THB. 1-year = monthly × 10 (≈2 months free).
 * Super admin price editing is a follow-up; these are the seeded defaults.
 */
export const DURATION_PRICES: Record<PaidTier, Record<BillingDuration, number>> = {
  starter: { "30d": 690, "1y": 6900 },
  standard: { "30d": 1290, "1y": 12900 },
  premium: { "30d": 2290, "1y": 22900 },
};

export function isPaidTier(plan: string): plan is PaidTier {
  return plan === "starter" || plan === "standard" || plan === "premium";
}

/** Returns the price in THB, or null for non-purchasable tiers (free/enterprise). */
export function getSubscriptionPrice(
  plan: BillingPlan,
  duration: BillingDuration,
): number | null {
  if (!isPaidTier(plan)) return null;
  return DURATION_PRICES[plan][duration];
}

/**
 * Computes the new expiry after a successful payment. Extends from the later of
 * `now` and the current expiry (so paying early stacks remaining time).
 */
export function computeNewExpiry(
  currentExpiryISO: string | null,
  duration: BillingDuration,
  now: Date = new Date(),
): string {
  const current = currentExpiryISO ? new Date(currentExpiryISO) : null;
  const base =
    current && !Number.isNaN(current.getTime()) && current.getTime() > now.getTime()
      ? current
      : now;
  const next = new Date(base.getTime());
  next.setUTCDate(next.getUTCDate() + DURATION_DAYS[duration]);
  return next.toISOString();
}

/** True when the subscription window is still valid at `now`. */
export function isSubscriptionCurrent(
  currentExpiryISO: string | null,
  now: Date = new Date(),
): boolean {
  if (!currentExpiryISO) return false;
  const exp = new Date(currentExpiryISO);
  return !Number.isNaN(exp.getTime()) && exp.getTime() > now.getTime();
}

/** True when the tenant should be allowed into the app billing gate. */
export function hasBillingAccess(state: BillingState, now: Date = new Date()): boolean {
  if (!isAccessAllowed(state)) return false;
  if (state.plan === "enterprise") return true;
  return (
    (isPaidTier(state.plan) || state.plan === "business") &&
    isSubscriptionCurrent(state.currentPeriodEnd, now)
  );
}
