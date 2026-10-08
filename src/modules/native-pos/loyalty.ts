import {z} from 'zod';
import QRCode from 'qrcode';
import {requireFeature} from '@/modules/auth/guards';
import {saveCustomer,getCustomerById} from '@/modules/customers/repository';
import {listLoyaltyLedgerForCustomer} from '@/modules/loyalty/repository';
import {getOrder} from '@/modules/pos/order-repository';
import {getReceiptLoyaltyClaimAction} from '@/app/pos/actions';
import {createSupabaseServerClient} from '@/server/integrations/supabase/server';
const id=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const createSchema=z.object({name:z.string().trim().min(1).max(120),phone:z.string().regex(/^\d{7,15}$/)}).strict();
export const loyaltyOperations=new Set(['customer-create','customer','customer-phone','receipt']);
const ok=(body:unknown)=>({body,status:200});
const fail=(error:string,status=400)=>({body:{error},status});
const customerDto=(c:{id:string;name:string;phone?:string},pointsBalance?:number)=>({id:c.id,name:c.name,phoneHint:c.phone?`••••${c.phone.slice(-4)}`:'',...(pointsBalance===undefined?{}:{pointsBalance})});
// Caller must verify bearer, store membership, billing and pos.use first.
export async function nativeLoyalty(operation:string,method:string,url:URL,body:unknown,scope:{storeId:string;organizationId:string;canLedger:boolean}):Promise<{body:unknown;status:number}|null>{
 if(!loyaltyOperations.has(operation))return null;
 try{await requireFeature('loyaltyPoints');}catch{return fail('แพ็กเกจนี้ไม่รองรับลูกค้าและแต้ม',403);}
 if(operation==='customer-phone'&&method==='GET'){
  const phone=url.searchParams.get('phone')??'';if(!/^0\d{9}$/.test(phone))return fail('เบอร์โทรต้องเป็นตัวเลข 10 หลัก และขึ้นต้นด้วย 0');
  const client=await createSupabaseServerClient();
  const result=await client.from('customers').select('id,name,phone').eq('store_id',scope.storeId).eq('organization_id',scope.organizationId).eq('is_active',true).eq('phone',phone).maybeSingle();
  if(result.error)return fail('ค้นหาลูกค้าไม่สำเร็จ กรุณาลองอีกครั้ง',502);
  return ok({customer:result.data?customerDto({...result.data,phone:result.data.phone??undefined}):null});
 }
 if(operation==='customer-create'&&method==='POST'){
  const parsed=createSchema.safeParse(body);if(!parsed.success)return fail('ระบุชื่อลูกค้าและเบอร์โทร 7–15 หลัก');
  const result=await saveCustomer({...parsed.data,storeId:scope.storeId,organizationId:scope.organizationId,isActive:true});
  if(result.error||!result.data)return fail(result.error?.userMessage??'ยังไม่ทราบผลเพิ่มลูกค้า กรุณาค้นหาเบอร์เดิมก่อนลองใหม่',409);
  return ok({customer:customerDto(result.data)});
 }
 if(operation==='customer'&&method==='GET'){
  const parsed=id.safeParse(url.searchParams.get('id'));if(!parsed.success)return fail('รหัสลูกค้าไม่ถูกต้อง');
  const result=await getCustomerById(scope.storeId,parsed.data);
  if(result.error)return fail('โหลดลูกค้าไม่สำเร็จ',502);
  if(!result.data||result.data.storeId!==scope.storeId||result.data.organizationId!==scope.organizationId)return fail('ไม่พบลูกค้าในร้านนี้',404);
  const client=await createSupabaseServerClient();
  const account=await client.from('loyalty_accounts').select('points_balance').eq('store_id',scope.storeId).eq('customer_id',parsed.data).maybeSingle();
  if(account.error)return fail('โหลดยอดแต้มไม่สำเร็จ',502);
  const ledger=scope.canLedger?await listLoyaltyLedgerForCustomer(scope.storeId,parsed.data,{limit:20}):{data:[],error:null};
  if(ledger.error)return fail('โหลดประวัติแต้มไม่สำเร็จ',502);
  return ok({customer:customerDto(result.data,account.data?.points_balance??0),canLedger:scope.canLedger,ledger:ledger.data??[]});
 }
 if(operation==='receipt'&&method==='POST'){
  const parsed=z.object({orderId:id}).strict().safeParse(body);if(!parsed.success)return fail('รหัสใบเสร็จไม่ถูกต้อง');
  const order=await getOrder(parsed.data.orderId);
  if(order.error)return fail('ตรวจใบเสร็จไม่สำเร็จ',502);
  if(!order.data||order.data.storeId!==scope.storeId||order.data.organizationId!==scope.organizationId)return fail('ไม่พบบิลในร้านนี้',404);
  if(order.data.status!=='paid')return fail('บิลนี้ยังไม่ใช่ใบเสร็จที่ชำระแล้ว',409);
  const result=await getReceiptLoyaltyClaimAction(parsed.data.orderId);
  if(result.error)return fail(result.error,502);
  if(!result.claim)return ok({orderId:parsed.data.orderId,claim:null,error:null});
  // Never render a receipt QR to an origin outside this authenticated backend.
  let claimUrl:URL;try{claimUrl=new URL(result.claim.url);}catch{return fail('ลิงก์รับแต้มไม่ถูกต้อง',502);}
  if(claimUrl.origin!==url.origin||!claimUrl.pathname.startsWith('/member/'))return fail('ปลายทางรับแต้มไม่ตรงกับร้าน',502);
  const imageUri=await QRCode.toDataURL(claimUrl.href,{errorCorrectionLevel:'M',margin:4,width:384});
  return ok({orderId:parsed.data.orderId,claim:{points:result.claim.points,expiresAt:result.claim.expiresAt,imageUri},error:null});
 }
 return fail('วิธีเรียกไม่ถูกต้อง',405);
}
