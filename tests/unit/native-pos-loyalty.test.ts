import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({feature:vi.fn(),save:vi.fn(),customer:vi.fn(),ledger:vi.fn(),order:vi.fn(),claim:vi.fn(),qr:vi.fn(),account:vi.fn(),lookup:vi.fn(),eq:vi.fn()}));
vi.mock('@/modules/auth/guards',()=>({requireFeature:m.feature}));
vi.mock('@/modules/customers/repository',()=>({saveCustomer:m.save,getCustomerById:m.customer}));
vi.mock('@/modules/loyalty/repository',()=>({listLoyaltyLedgerForCustomer:m.ledger}));
vi.mock('@/modules/pos/order-repository',()=>({getOrder:m.order}));
vi.mock('@/app/pos/actions',()=>({getReceiptLoyaltyClaimAction:m.claim}));
vi.mock('qrcode',()=>({default:{toDataURL:m.qr}}));
vi.mock('@/server/integrations/supabase/server',()=>({createSupabaseServerClient:async()=>({from:(table:string)=>{const q:any={select:()=>q,eq:(...args:unknown[])=>{m.eq(...args);return q},maybeSingle:table==='customers'?m.lookup:m.account};return q;}})}));
import {nativeLoyalty} from '@/modules/native-pos/loyalty';
const id='cccccccc-0000-0000-0000-000000000002';
const scope={storeId:'store',organizationId:'org',canLedger:true};
const url=new URL('https://example.test/api/mobile/pos/customer?id='+id);
beforeEach(()=>{vi.clearAllMocks();m.feature.mockResolvedValue(undefined);m.customer.mockResolvedValue({data:{id,storeId:'store',organizationId:'org',name:'ลูกค้า',phone:'0812345678'},error:null});m.save.mockResolvedValue({data:{id,name:'ใหม่',phone:'0812345678'},error:null});m.account.mockResolvedValue({data:{points_balance:12},error:null});m.ledger.mockResolvedValue({data:[],error:null});m.order.mockResolvedValue({data:{id,storeId:'store',organizationId:'org',status:'paid'},error:null});m.claim.mockResolvedValue({error:null,claim:{url:'https://example.test/member/shop?claim=x',code:'x',points:5,expiresAt:'2099-01-01T00:00:00Z'}});m.qr.mockResolvedValue('data:image/png;base64,AA==');});
it('creates only digit phone customer in verified store and never updates an existing customer',async()=>{
 expect((await nativeLoyalty('customer-create','POST',url,{name:' ใหม่ ',phone:'0812345678'},scope))?.status).toBe(200);
 expect(m.save).toHaveBeenCalledWith({name:'ใหม่',phone:'0812345678',storeId:'store',organizationId:'org',isActive:true});
 for(const body of [{name:'',phone:'0812345678'},{name:'a',phone:'abc'},{name:'a',phone:'0812345678',id},{name:'a',phone:'123'}])expect((await nativeLoyalty('customer-create','POST',url,body,scope))?.status).toBe(400);
 expect(m.save).toHaveBeenCalledTimes(1);
 m.save.mockResolvedValueOnce({data:null,error:{userMessage:'เบอร์ซ้ำ'}});expect((await nativeLoyalty('customer-create','POST',url,{name:'ใหม่',phone:'0812345678'},scope))?.status).toBe(409);
});
it('looks up exactly ten phone digits within the verified active store without partial matches',async()=>{
 const phoneUrl=new URL('https://example.test/api/mobile/pos/customer-phone?phone=0812345678');
 m.lookup.mockResolvedValueOnce({data:{id,name:'ลูกค้า',phone:'0812345678'},error:null});
 expect((await nativeLoyalty('customer-phone','GET',phoneUrl,null,scope))?.body).toEqual({customer:{id,name:'ลูกค้า',phoneHint:'••••5678'}});
 expect(m.eq).toHaveBeenCalledWith('phone','0812345678');expect(m.eq).toHaveBeenCalledWith('store_id','store');expect(m.eq).toHaveBeenCalledWith('organization_id','org');expect(m.eq).toHaveBeenCalledWith('is_active',true);
 m.lookup.mockResolvedValueOnce({data:null,error:null});expect((await nativeLoyalty('customer-phone','GET',phoneUrl,null,scope))?.body).toEqual({customer:null});
 for(const phone of ['081234567','08123456789','9812345678','081-2345678'])expect((await nativeLoyalty('customer-phone','GET',new URL('https://example.test/?phone='+phone),null,scope))?.status).toBe(400);
 expect(m.lookup).toHaveBeenCalledTimes(2);
});
it('checks entitlement before any loyalty read/write',async()=>{m.feature.mockRejectedValue(Error('denied'));expect((await nativeLoyalty('customer','GET',url,null,scope))?.status).toBe(403);expect(m.customer).not.toHaveBeenCalled();expect(m.save).not.toHaveBeenCalled();});
it('returns authoritative balance, masked phone and hides ledger without catalog permission',async()=>{
 const result=await nativeLoyalty('customer','GET',url,null,{...scope,canLedger:false});
 expect(result?.body).toEqual({customer:{id,name:'ลูกค้า',phoneHint:'••••5678',pointsBalance:12},canLedger:false,ledger:[]});expect(m.ledger).not.toHaveBeenCalled();
 m.customer.mockResolvedValueOnce({data:{id,storeId:'foreign',organizationId:'org'},error:null});expect((await nativeLoyalty('customer','GET',url,null,scope))?.status).toBe(404);
 expect(m.account).toHaveBeenCalledTimes(1);
});
it('does not replace database failures with zero points',async()=>{m.account.mockResolvedValueOnce({data:null,error:{message:'db'}});expect((await nativeLoyalty('customer','GET',url,null,scope))?.status).toBe(502);});
it('issues QR inside paid receipt response only and rejects foreign/unpaid orders',async()=>{
 const result=await nativeLoyalty('receipt','POST',url,{orderId:id},scope);expect(result?.status).toBe(200);expect(result?.body).toMatchObject({orderId:id,claim:{points:5,imageUri:'data:image/png;base64,AA=='}});
 m.order.mockResolvedValueOnce({data:{id,storeId:'foreign',organizationId:'org',status:'paid'},error:null});expect((await nativeLoyalty('receipt','POST',url,{orderId:id},scope))?.status).toBe(404);
 m.order.mockResolvedValueOnce({data:{id,storeId:'store',organizationId:'org',status:'pending'},error:null});expect((await nativeLoyalty('receipt','POST',url,{orderId:id},scope))?.status).toBe(409);
 expect(m.claim).toHaveBeenCalledTimes(1);
});
it('keeps QR failures separate from order payment and rejects external URLs',async()=>{
 m.claim.mockResolvedValueOnce({claim:null,error:null});expect((await nativeLoyalty('receipt','POST',url,{orderId:id},scope))?.body).toEqual({orderId:id,claim:null,error:null});
 m.claim.mockResolvedValueOnce({claim:null,error:'ยังโหลดไม่ได้'});expect((await nativeLoyalty('receipt','POST',url,{orderId:id},scope))?.status).toBe(502);
 m.claim.mockResolvedValueOnce({claim:{url:'https://evil.test/x'},error:null});expect((await nativeLoyalty('receipt','POST',url,{orderId:id},scope))?.status).toBe(502);expect(m.qr).not.toHaveBeenCalled();
});
