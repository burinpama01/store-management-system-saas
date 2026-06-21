export type CouponDiscountType = "amount" | "percentage";

export type CouponRejectionReason =
  | "coupon_code_mismatch"
  | "coupon_inactive"
  | "coupon_wrong_store"
  | "coupon_not_started"
  | "coupon_expired"
  | "coupon_min_subtotal"
  | "coupon_usage_limit"
  | "coupon_customer_usage_limit"
  | "coupon_customer_required"
  | "coupon_manual_discount_conflict"
  | "coupon_invalid_discount";

export interface CouponPolicy {
  id: string;
  storeId: string;
  code: string;
  name: string;
  discountType: CouponDiscountType;
  discountValue: number;
  minSubtotal: number;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive: boolean;
  maxRedemptions?: number | null;
  redeemedCount: number;
  maxRedemptionsPerCustomer?: number | null;
  customerRedeemedCount: number;
  customerIds?: string[];
  stackableWithManualDiscount?: boolean;
}

export interface CouponEvaluationInput {
  coupon: CouponPolicy;
  cart: {
    storeId: string;
    subtotal: number;
    discount: number;
  };
  code: string;
  customerId?: string | null;
  now?: string | Date;
}

export type CouponEvaluation =
  | {
      ok: true;
      couponId: string;
      discount: number;
      normalizedCode: string;
    }
  | {
      ok: false;
      discount: 0;
      normalizedCode: string;
      reason: CouponRejectionReason;
    };
