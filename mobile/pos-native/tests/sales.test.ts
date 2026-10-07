import { expect, it } from 'vitest';
import { salesFingerprint, confirmedSale, salesAmount } from '../src/domain/sales';
import { emptyDraft } from '../src/domain/cart';
const cart = { ...emptyDraft('store','user'), revision: 2, lines: [{ key:'p',productId:'p',name:'ชา',quantity:2,unitSatang:5000,variantId:null,optionIds:[],note:'' }] };
const selection = { customerId:'customer',couponCode:'SAVE',manualDiscountSatang:500 };
const quote = { subtotalSatang:10000,manualDiscountSatang:500,couponDiscountSatang:1000,totalSatang:8500,couponCode:'SAVE' };
it('invalidates confirmation when cart, customer, coupon or manual amount changes', () => {
  const snapshot = { fingerprint:salesFingerprint(cart,selection),quote };
  expect(confirmedSale(cart,selection,snapshot)).toEqual(quote);
  for (const [draft,choice] of [[{...cart,revision:3},selection],[cart,{...selection,customerId:'other'}],[cart,{...selection,couponCode:'OTHER'}],[cart,{...selection,manualDiscountSatang:0}]] as const) expect(()=>confirmedSale(draft,choice,snapshot)).toThrow('ตรวจยอด');
});
it('rejects malformed/oversized amounts and internally inconsistent quote before receiving cash', () => {
  expect(salesAmount('10.25')).toBe(1025);
  for(const value of ['-1','1e3','1.001','NaN','100000001'])expect(()=>salesAmount(value)).toThrow();
  expect(()=>confirmedSale(cart,selection,{fingerprint:salesFingerprint(cart,selection),quote:{...quote,totalSatang:1}})).toThrow();
});
