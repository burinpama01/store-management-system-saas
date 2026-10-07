import type { NativeSalesInput, NativeSaleQuote } from '../../../../src/modules/native-pos/contracts';
import type { Draft } from './cart';
export type ConfirmedSale = { fingerprint: string; quote: NativeSaleQuote };
export function salesFingerprint(cart: Draft, selection: NativeSalesInput) {
  return JSON.stringify([cart.storeId, cart.userId, cart.revision, cart.lines, selection.customerId ?? null, selection.couponCode?.trim() || null, selection.manualDiscountSatang ?? 0]);
}
export function salesAmount(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('กรอกจำนวนเงินทศนิยมไม่เกิน 2 ตำแหน่ง');
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 10000000000) throw new Error('จำนวนเงินเกินขอบเขต');
  return amount;
}
export function confirmedSale(cart: Draft, selection: NativeSalesInput, snapshot: ConfirmedSale | null): NativeSaleQuote {
  if (!snapshot || snapshot.fingerprint !== salesFingerprint(cart, selection)) throw new Error('รายการเปลี่ยน กรุณาตรวจยอดใหม่ก่อนรับเงิน');
  const q = snapshot.quote;
  if (![q.subtotalSatang,q.manualDiscountSatang,q.couponDiscountSatang,q.totalSatang].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000000)
    || q.subtotalSatang - q.manualDiscountSatang - q.couponDiscountSatang !== q.totalSatang || q.totalSatang <= 0
    || q.manualDiscountSatang !== (selection.manualDiscountSatang ?? 0)) throw new Error('ผลตรวจยอดไม่ถูกต้อง กรุณาตรวจยอดใหม่');
  return q;
}
