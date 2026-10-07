import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ coupon: vi.fn(), customer: vi.fn(), feature: vi.fn() }));
vi.mock('@/app/pos/actions', () => ({ evaluatePosCouponAction: mocks.coupon }));
vi.mock('@/modules/customers/repository', () => ({ getCustomerById: mocks.customer }));
vi.mock('@/modules/auth/guards', () => ({ requireFeature: mocks.feature }));
import { quoteNativeSale } from '@/modules/native-pos/sales';
const cart = { storeId: 'store', items: [], subtotal: 100, discount: 0, total: 100 };
beforeEach(() => { vi.clearAllMocks(); mocks.feature.mockResolvedValue(undefined); mocks.customer.mockResolvedValue({ data: { id: 'customer', storeId: 'store', isActive: true }, error: null }); mocks.coupon.mockResolvedValue({ couponId: 'coupon', normalizedCode: 'SAVE', discount: 10, error: null }); });
it('uses server coupon amount after manual discount and never trusts a client coupon amount', async () => {
  const result = await quoteNativeSale(cart, { customerId: 'customer', couponCode: 'save', manualDiscountSatang: 500 }, true);
  expect(result.quote).toEqual({ subtotalSatang: 10000, manualDiscountSatang: 500, couponDiscountSatang: 1000, totalSatang: 8500, couponCode: 'SAVE' });
  expect(mocks.coupon).toHaveBeenCalledWith('save', expect.objectContaining({ total: 95, discount: 5 }), 'customer');
});
it('rejects manual discount without permission and an invalid scoped customer', async () => {
  await expect(quoteNativeSale(cart, { manualDiscountSatang: 100 }, false)).rejects.toThrow('สิทธิ์');
  mocks.customer.mockResolvedValueOnce({ data: null, error: null });
  await expect(quoteNativeSale(cart, { customerId: 'other' }, true)).rejects.toThrow('ลูกค้า');
  expect(mocks.coupon).not.toHaveBeenCalled();
});
it('fails closed on expired coupon, product rewards and zero-total sale', async () => {
  mocks.coupon.mockResolvedValueOnce({ error: 'หมดอายุ' });
  await expect(quoteNativeSale(cart, { couponCode: 'expired' }, true)).rejects.toThrow('หมดอายุ');
  mocks.coupon.mockResolvedValueOnce({ rewardProduct: { productId: 'free' }, error: null });
  await expect(quoteNativeSale(cart, { couponCode: 'gift' }, true)).rejects.toThrow('สินค้า');
  mocks.coupon.mockResolvedValueOnce({ discount: 100, couponId: 'free', normalizedCode: 'FREE', error: null });
  await expect(quoteNativeSale(cart, { couponCode: 'free' }, true)).rejects.toThrow('ศูนย์');
});
