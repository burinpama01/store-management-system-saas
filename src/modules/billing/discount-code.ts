import type { BillingDuration, PaidTier } from "./pricing";

/** A super-admin-managed discount code that can be applied at billing checkout. */
export interface BillingDiscountCode {
  id: string;
  code: string;
  normalizedCode: string;
  description: string;
  discountType: "percentage" | "fixed";
  discountValue: number;
  /** null = applies to every paid plan. */
  plan: PaidTier | null;
  /** null = applies to every duration. */
  duration: BillingDuration | null;
  minAmount: number;
  /** null = unlimited globally. */
  maxRedemptions: number | null;
  /** null = unlimited per organization. */
  maxRedemptionsPerOrg: number | null;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export type DiscountRejectionReason =
  | "code_not_found"
  | "code_mismatch"
  | "inactive"
  | "not_started"
  | "expired"
  | "plan_mismatch"
  | "duration_mismatch"
  | "min_amount"
  | "usage_limit"
  | "org_usage_limit"
  | "invalid_discount";

export interface DiscountEvaluation {
  ok: boolean;
  discount: number;
  normalizedCode: string;
  reason?: DiscountRejectionReason;
  codeId?: string;
  description?: string;
}

export interface DiscountEvaluationInput {
  code: string;
  plan: PaidTier;
  duration: BillingDuration;
  /** Amount the discount applies to (the post-promotion plan price). */
  baseAmount: number;
  discount: BillingDiscountCode;
  /** Verified redemptions of this code across all tenants. */
  globalRedeemed: number;
  /** Verified redemptions of this code by the current tenant. */
  orgRedeemed: number;
  now?: string | Date | null;
}

export function normalizeDiscountCode(code: string): string {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

function roundBaht(value: number): number {
  return Math.round(value);
}

function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function reject(normalizedCode: string, reason: DiscountRejectionReason): DiscountEvaluation {
  return { ok: false, discount: 0, normalizedCode, reason };
}

/**
 * Pure: decides whether a discount code applies to a plan/duration/price and how
 * much it takes off. The discount is computed on `baseAmount` (the price after any
 * automatic promotion) and rounded to the nearest baht, never exceeding it.
 */
export function evaluateBillingDiscount(input: DiscountEvaluationInput): DiscountEvaluation {
  const normalizedCode = normalizeDiscountCode(input.code);
  const codeNormalized = normalizeDiscountCode(input.discount.code);
  if (!normalizedCode || normalizedCode !== codeNormalized) {
    return reject(normalizedCode, "code_mismatch");
  }

  if (!input.discount.active) return reject(normalizedCode, "inactive");

  const now = asDate(input.now) ?? new Date();
  const startsAt = asDate(input.discount.startsAt);
  const endsAt = asDate(input.discount.endsAt);
  if (startsAt && now < startsAt) return reject(normalizedCode, "not_started");
  if (endsAt && now > endsAt) return reject(normalizedCode, "expired");

  if (input.discount.plan !== null && input.discount.plan !== input.plan) {
    return reject(normalizedCode, "plan_mismatch");
  }
  if (input.discount.duration !== null && input.discount.duration !== input.duration) {
    return reject(normalizedCode, "duration_mismatch");
  }

  const minAmount = Math.max(0, input.discount.minAmount || 0);
  if (input.baseAmount < minAmount) return reject(normalizedCode, "min_amount");

  if (
    input.discount.maxRedemptions !== null &&
    input.globalRedeemed >= input.discount.maxRedemptions
  ) {
    return reject(normalizedCode, "usage_limit");
  }

  if (
    input.discount.maxRedemptionsPerOrg !== null &&
    input.orgRedeemed >= input.discount.maxRedemptionsPerOrg
  ) {
    return reject(normalizedCode, "org_usage_limit");
  }

  if (input.baseAmount <= 0) return reject(normalizedCode, "invalid_discount");

  const rawDiscount =
    input.discount.discountType === "percentage"
      ? input.baseAmount * (input.discount.discountValue / 100)
      : input.discount.discountValue;
  const discount = roundBaht(Math.min(input.baseAmount, rawDiscount));

  if (!Number.isFinite(discount) || discount <= 0) {
    return reject(normalizedCode, "invalid_discount");
  }

  return {
    ok: true,
    discount,
    normalizedCode,
    codeId: input.discount.id,
    description: input.discount.description,
  };
}

const REJECTION_MESSAGES: Record<DiscountRejectionReason, string> = {
  code_not_found: "ไม่พบโค้ดส่วนลดนี้",
  code_mismatch: "ไม่พบโค้ดส่วนลดนี้",
  inactive: "โค้ดส่วนลดนี้ถูกปิดใช้งาน",
  not_started: "โค้ดส่วนลดนี้ยังไม่เริ่มใช้งาน",
  expired: "โค้ดส่วนลดนี้หมดอายุแล้ว",
  plan_mismatch: "โค้ดส่วนลดนี้ใช้กับแพ็กเกจที่เลือกไม่ได้",
  duration_mismatch: "โค้ดส่วนลดนี้ใช้กับระยะเวลาที่เลือกไม่ได้",
  min_amount: "ยอดยังไม่ถึงขั้นต่ำสำหรับโค้ดส่วนลดนี้",
  usage_limit: "โค้ดส่วนลดนี้ถูกใช้ครบจำนวนแล้ว",
  org_usage_limit: "บัญชีนี้ใช้สิทธิ์โค้ดส่วนลดนี้ครบแล้ว",
  invalid_discount: "ใช้โค้ดส่วนลดนี้ไม่ได้",
};

export function describeDiscountRejection(reason: DiscountRejectionReason): string {
  return REJECTION_MESSAGES[reason] ?? "ใช้โค้ดส่วนลดนี้ไม่ได้";
}
