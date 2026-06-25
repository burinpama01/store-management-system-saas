import type { Cart } from "@/modules/pos/types";
import { evaluateCouponForCart } from "@/modules/promotions/coupon-policy";
import type { CouponPolicy } from "@/modules/promotions/types";

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export type GroceryCheckoutCartResult =
  | {
      ok: true;
      cart: Cart;
      couponId: string | null;
      couponDiscountAmount: number;
      couponCode: string | null;
    }
  | {
      ok: false;
      error: string;
    };

export function buildGroceryCheckoutCart(input: {
  trustedCart: Cart;
  coupon?: CouponPolicy | null;
  couponCode?: string | null;
  customerId?: string | null;
  clientCouponDiscountAmount?: number | null;
}): GroceryCheckoutCartResult {
  if (!input.coupon && !input.couponCode) {
    return {
      ok: true,
      cart: input.trustedCart,
      couponId: null,
      couponDiscountAmount: 0,
      couponCode: null,
    };
  }

  if (!input.coupon || !input.couponCode) {
    return { ok: false, error: "ไม่พบคูปองนี้" };
  }

  const evaluation = evaluateCouponForCart({
    coupon: input.coupon,
    cart: input.trustedCart,
    code: input.couponCode,
    customerId: input.customerId,
  });

  if (!evaluation.ok) {
    return { ok: false, error: evaluation.reason };
  }

  if (
    input.clientCouponDiscountAmount !== null &&
    input.clientCouponDiscountAmount !== undefined &&
    roundMoney(input.clientCouponDiscountAmount) !== evaluation.discount
  ) {
    return { ok: false, error: "ยอดส่วนลดคูปองไม่ตรงกับนโยบาย" };
  }

  const totalDiscount = roundMoney(input.trustedCart.discount + evaluation.discount);
  return {
    ok: true,
    cart: {
      ...input.trustedCart,
      discount: totalDiscount,
      discountType: undefined,
      discountValue: undefined,
      discountNote: input.trustedCart.discountNote
        ? `${input.trustedCart.discountNote}; Coupon ${evaluation.normalizedCode}`
        : `Coupon ${evaluation.normalizedCode}`,
      total: roundMoney(input.trustedCart.subtotal - totalDiscount),
    },
    couponId: evaluation.couponId,
    couponDiscountAmount: evaluation.discount,
    couponCode: evaluation.normalizedCode,
  };
}
