import {expect,it} from 'vitest';
import {canCreateCustomer,receiptClaimVisible,phoneLookupReady} from '../src/domain/loyalty';
it('automatically looks up only a full ten digit phone',()=>{expect(phoneLookupReady('0812345678')).toBe(true);for(const p of ['','081234567','08123456789','9812345678','081-2345678'])expect(phoneLookupReady(p)).toBe(false)});
it('requires a name and digit phone with leading zero preserved',()=>{expect(canCreateCustomer('ใหม่','0812345678')).toBe(true);for(const [n,p] of [['','0812345678'],['ใหม่','123'],['ใหม่','081-2345678'],['ใหม่','+66812345678']])expect(canCreateCustomer(n,p)).toBe(false);});
it('shows points QR only on an unexpired paid receipt for the same order',()=>{
 const claim={points:5,expiresAt:'2099-01-01T00:00:00Z',imageUri:'data:image/png;base64,AA=='};
 expect(receiptClaimVisible({id:'a',status:'paid'},{orderId:'a',claim},0)).toBe(true);
 expect(receiptClaimVisible({id:'a',status:'pending'},{orderId:'a',claim},0)).toBe(false);
 expect(receiptClaimVisible({id:'b',status:'paid'},{orderId:'a',claim},0)).toBe(false);
 expect(receiptClaimVisible({id:'a',status:'paid'},{orderId:'a',claim:{...claim,expiresAt:'bad'}},0)).toBe(false);
 expect(receiptClaimVisible({id:'a',status:'paid'},{orderId:'a',claim},Date.parse('2099-01-01'))).toBe(false);
});
