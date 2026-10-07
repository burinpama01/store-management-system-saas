import { evaluatePosCouponAction } from '@/app/pos/actions';
import { requireFeature } from '@/modules/auth/guards';
import { getCustomerById } from '@/modules/customers/repository';
import type { Cart } from '@/modules/pos/types';
import type { NativeSalesInput, NativeSaleQuote } from './contracts';
import { satang } from './catalog';

/** Preview only: checkout and its SQL transaction independently revalidate. */
export async function quoteNativeSale(original: Cart, input: NativeSalesInput, canDiscount: boolean): Promise<{ cart: Cart; quote: NativeSaleQuote }> {
  const manual = input.manualDiscountSatang ?? 0;
  if (!Number.isSafeInteger(manual) || manual < 0 || manual > satang(original.subtotal)) throw new Error('ส่วนลดไม่ถูกต้อง');
  if (manual > 0 && !canDiscount) throw new Error('ไม่มีสิทธิ์ลดราคา');
  if (input.customerId) {
    await requireFeature('loyaltyPoints');
    const customer = await getCustomerById(original.storeId, input.customerId);
    if (customer.error || !customer.data || customer.data.storeId !== original.storeId || !customer.data.isActive) throw new Error('ลูกค้าไม่พร้อมใช้งานในร้านนี้');
  }
  const cart: Cart = { ...original, discount: manual / 100, total: (satang(original.subtotal) - manual) / 100, ...(manual ? { discountNote: 'ส่วนลดท้ายบิลจากแอป' } : {}) };
  let couponDiscount = 0; let couponCode: string | null = null;
  if (input.couponCode?.trim()) {
    const coupon = await evaluatePosCouponAction(input.couponCode.trim(), cart, input.customerId);
    if (coupon.error) throw new Error(coupon.error);
    if (coupon.rewardProduct) throw new Error('คูปองแลกสินค้าให้ทำบนเว็บก่อน แอปรองรับคูปองส่วนลด');
    couponDiscount = satang(coupon.discount);
    if (!coupon.couponId || !coupon.normalizedCode || !Number.isSafeInteger(couponDiscount) || couponDiscount <= 0 || couponDiscount > satang(cart.total)) throw new Error('คูปองไม่ถูกต้อง');
    couponCode = coupon.normalizedCode;
  }
  const total = satang(cart.total) - couponDiscount;
  if (total <= 0) throw new Error('บิลยอดศูนย์ให้ทำบนเว็บก่อน');
  return { cart, quote: { subtotalSatang: satang(original.subtotal), manualDiscountSatang: manual, couponDiscountSatang: couponDiscount, totalSatang: total, couponCode } };
}
