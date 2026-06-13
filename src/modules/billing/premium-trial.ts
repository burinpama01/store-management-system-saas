import type { BillingDuration } from "./pricing";

export const PREMIUM_FREE_TRIAL_PROMO_CODE = "premium_free_30d_once";
export const PREMIUM_FREE_TRIAL_DAYS = 30;

export type PremiumFreeTrialUnavailableReason =
  | "unsupported_selection"
  | "already_redeemed"
  | "active_subscription";

export interface PremiumFreeTrialOffer {
  selectionMatches: boolean;
  available: boolean;
  basePrice: number;
  finalAmount: number;
  credit: number;
  days: number;
  promotionCode: typeof PREMIUM_FREE_TRIAL_PROMO_CODE;
  promotionLabel: string;
  unavailableReason: PremiumFreeTrialUnavailableReason | null;
}

export function isPremiumFreeTrialSelection(plan: string, duration: BillingDuration): boolean {
  return plan === "premium" && duration === "30d";
}

export function computePremiumFreeTrialExpiry(now: Date = new Date()): string {
  const next = new Date(now.getTime());
  next.setUTCDate(next.getUTCDate() + PREMIUM_FREE_TRIAL_DAYS);
  return next.toISOString();
}

export function buildPremiumFreeTrialOffer(input: {
  plan: string;
  duration: BillingDuration;
  basePrice: number;
  alreadyRedeemed: boolean;
  activeSubscription?: boolean;
}): PremiumFreeTrialOffer {
  const selectionMatches = isPremiumFreeTrialSelection(input.plan, input.duration);
  const available = selectionMatches && !input.alreadyRedeemed && !input.activeSubscription;

  return {
    selectionMatches,
    available,
    basePrice: input.basePrice,
    finalAmount: available ? 0 : input.basePrice,
    credit: 0,
    days: PREMIUM_FREE_TRIAL_DAYS,
    promotionCode: PREMIUM_FREE_TRIAL_PROMO_CODE,
    promotionLabel: "Premium ฟรี 30 วัน (ใช้ได้ 1 ครั้ง)",
    unavailableReason: !selectionMatches
      ? "unsupported_selection"
      : input.alreadyRedeemed
        ? "already_redeemed"
        : input.activeSubscription
          ? "active_subscription"
        : null,
  };
}
