import type { CouponEvaluation, CouponEvaluationInput, CouponRejectionReason } from "./types";

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normalizeCouponCode(code: string): string {
  return code.trim().replace(/\s+/g, "").toUpperCase();
}

function reject(normalizedCode: string, reason: CouponRejectionReason): CouponEvaluation {
  return { ok: false, discount: 0, normalizedCode, reason };
}

function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function evaluateCouponForCart(input: CouponEvaluationInput): CouponEvaluation {
  const normalizedCode = normalizeCouponCode(input.code);
  const couponCode = normalizeCouponCode(input.coupon.code);
  if (!normalizedCode || normalizedCode !== couponCode) {
    return reject(normalizedCode, "coupon_code_mismatch");
  }

  if (!input.coupon.isActive) return reject(normalizedCode, "coupon_inactive");
  if (input.coupon.storeId !== input.cart.storeId) return reject(normalizedCode, "coupon_wrong_store");

  const now = asDate(input.now) ?? new Date();
  const startsAt = asDate(input.coupon.startsAt);
  const endsAt = asDate(input.coupon.endsAt);
  if (startsAt && now < startsAt) return reject(normalizedCode, "coupon_not_started");
  if (endsAt && now > endsAt) return reject(normalizedCode, "coupon_expired");

  const minSubtotal = Math.max(0, input.coupon.minSubtotal || 0);
  if (input.cart.subtotal < minSubtotal) return reject(normalizedCode, "coupon_min_subtotal");

  if (
    input.coupon.maxRedemptions !== null &&
    input.coupon.maxRedemptions !== undefined &&
    input.coupon.redeemedCount >= input.coupon.maxRedemptions
  ) {
    return reject(normalizedCode, "coupon_usage_limit");
  }

  const customerTargets = input.coupon.customerIds ?? [];
  if (customerTargets.length > 0 && (!input.customerId || !customerTargets.includes(input.customerId))) {
    return reject(normalizedCode, "coupon_customer_required");
  }

  if (
    input.coupon.maxRedemptionsPerCustomer !== null &&
    input.coupon.maxRedemptionsPerCustomer !== undefined &&
    input.coupon.customerRedeemedCount >= input.coupon.maxRedemptionsPerCustomer
  ) {
    return reject(normalizedCode, "coupon_customer_usage_limit");
  }

  if (input.cart.discount > 0 && input.coupon.stackableWithManualDiscount !== true) {
    return reject(normalizedCode, "coupon_manual_discount_conflict");
  }

  const discountBase = roundMoney(Math.max(0, input.cart.subtotal - input.cart.discount));
  if (discountBase <= 0) return reject(normalizedCode, "coupon_invalid_discount");

  const rawDiscount =
    input.coupon.discountType === "percentage"
      ? discountBase * (input.coupon.discountValue / 100)
      : input.coupon.discountValue;
  const discount = roundMoney(Math.min(discountBase, rawDiscount));

  if (!Number.isFinite(discount) || discount <= 0) {
    return reject(normalizedCode, "coupon_invalid_discount");
  }

  return {
    ok: true,
    couponId: input.coupon.id,
    discount,
    normalizedCode,
  };
}
