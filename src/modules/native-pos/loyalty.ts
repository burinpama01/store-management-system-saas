import {z} from 'zod';
import QRCode from 'qrcode';
import {requireFeature} from '@/modules/auth/guards';
import {saveCustomer,getCustomerById} from '@/modules/customers/repository';
import {listLoyaltyLedgerForCustomer} from '@/modules/loyalty/repository';
import {getOrder} from '@/modules/pos/order-repository';
import {getReceiptLoyaltyClaimAction} from '@/app/pos/actions';
import {createSupabaseServerClient} from '@/server/integrations/supabase/server';
import {logSystemEvent} from '@/modules/system/event-log';

const id=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
// Same rule for create and lookup: a customer created here must be findable by the 10-digit lookup.
const thaiPhone=/^0\d{9}$/;
const PHONE_RULE='เบอร์โทรต้องเป็นตัวเลข 10 หลัก และขึ้นต้นด้วย 0';
const createSchema=z.object({name:z.string().trim().min(1).max(120),phone:z.string().regex(thaiPhone)}).strict();
export const loyaltyOperations=new Set(['customer-create','customer','customer-phone','receipt']);
const ALLOWED:Record<string,string>={'customer-create':'POST','customer':'GET','customer-phone':'GET','receipt':'POST'};
export interface NativeLoyaltyScope {storeId:string;organizationId:string;canLedger:boolean;userId?:string|null}
type Result={body:unknown;status:number};
const ok=(body:unknown):Result=>({body,status:200});
const fail=(error:string,status=400):Result=>({body:{error},status});
const customerDto=(c:{id:string;name:string;phone?:string},pointsBalance?:number)=>({id:c.id,name:c.name,phoneHint:c.phone?`••••${c.phone.slice(-4)}`:'',...(pointsBalance===undefined?{}:{pointsBalance:Number(pointsBalance)})});

function log(scope:NativeLoyaltyScope,level:'info'|'warn'|'error',action:string,message:string,context:Record<string,unknown>,errorCode?:string|null){
 // Fire-and-forget: logging never blocks or fails the cashier's request. Never pass phone numbers here.
 void logSystemEvent({level,source:'native-pos.loyalty',action,message,errorCode:errorCode??null,organizationId:scope.organizationId,storeId:scope.storeId,actorUserId:scope.userId??null,context});
}

// Caller must verify bearer, store membership, billing and pos.use first.
export async function nativeLoyalty(operation:string,method:string,url:URL,body:unknown,scope:NativeLoyaltyScope):Promise<Result|null>{
 if(!loyaltyOperations.has(operation))return null;
 if(ALLOWED[operation]!==method)return fail(`${operation} ต้องเรียกด้วย ${ALLOWED[operation]}`,405);
 try{await requireFeature('loyaltyPoints');}catch{return fail('แพ็กเกจนี้ไม่รองรับลูกค้าและแต้ม',403);}

 if(operation==='customer-phone'){
  const phone=url.searchParams.get('phone')??'';if(!thaiPhone.test(phone))return fail(PHONE_RULE);
  const client=await createSupabaseServerClient();
  const result=await client.from('customers').select('id,name,phone').eq('store_id',scope.storeId).eq('organization_id',scope.organizationId).eq('is_active',true).eq('phone',phone).maybeSingle();
  if(result.error){log(scope,'error','customerPhoneLookup','ค้นหาลูกค้าด้วยเบอร์ไม่สำเร็จ',{},result.error.code);return fail('ค้นหาลูกค้าไม่สำเร็จ กรุณาลองอีกครั้ง',502);}
  log(scope,'info','customerPhoneLookup',result.data?'พบลูกค้าจากเบอร์':'ไม่พบลูกค้าจากเบอร์',{found:!!result.data});
  return ok({customer:result.data?customerDto({...result.data,phone:result.data.phone??undefined}):null});
 }

 if(operation==='customer-create'){
  const parsed=createSchema.safeParse(body);if(!parsed.success)return fail(`ระบุชื่อลูกค้า และ${PHONE_RULE}`);
  const result=await saveCustomer({...parsed.data,storeId:scope.storeId,organizationId:scope.organizationId,isActive:true});
  if(result.error){
   const taken=result.error.code==='customer_phone_taken';
   log(scope,taken?'warn':'error','customerCreate',taken?'เพิ่มลูกค้าไม่สำเร็จ: เบอร์ซ้ำ':'เพิ่มลูกค้าไม่สำเร็จ',{},result.error.code);
   // 409 only for a duplicate phone; anything else is a server-side failure the app must not treat as "search the existing customer".
   return taken?fail(result.error.userMessage,409):fail(result.error.userMessage||'เพิ่มลูกค้าไม่สำเร็จ กรุณาลองอีกครั้ง',502);
  }
  if(!result.data){log(scope,'error','customerCreate','เพิ่มลูกค้าแล้วไม่ได้ข้อมูลกลับ',{});return fail('ยังไม่ทราบผลเพิ่มลูกค้า กรุณาค้นหาเบอร์เดิมก่อนลองใหม่',502);}
  log(scope,'info','customerCreate','เพิ่มลูกค้าจากแอป native',{customerId:result.data.id});
  return ok({customer:customerDto(result.data)});
 }

 if(operation==='customer'){
  const parsed=id.safeParse(url.searchParams.get('id'));if(!parsed.success)return fail('รหัสลูกค้าไม่ถูกต้อง');
  const result=await getCustomerById(scope.storeId,parsed.data);
  if(result.error){log(scope,'error','customerDetail','โหลดลูกค้าไม่สำเร็จ',{customerId:parsed.data},result.error.code);return fail('โหลดลูกค้าไม่สำเร็จ',502);}
  if(!result.data||result.data.storeId!==scope.storeId||result.data.organizationId!==scope.organizationId)return fail('ไม่พบลูกค้าในร้านนี้',404);
  const client=await createSupabaseServerClient();
  const account=await client.from('loyalty_accounts').select('points_balance').eq('store_id',scope.storeId).eq('organization_id',scope.organizationId).eq('customer_id',parsed.data).maybeSingle();
  if(account.error){log(scope,'error','customerDetail','โหลดยอดแต้มไม่สำเร็จ',{customerId:parsed.data},account.error.code);return fail('โหลดยอดแต้มไม่สำเร็จ',502);}
  const ledger=scope.canLedger?await listLoyaltyLedgerForCustomer(scope.storeId,parsed.data,{limit:20}):{data:[],error:null};
  if(ledger.error){log(scope,'error','customerDetail','โหลดประวัติแต้มไม่สำเร็จ',{customerId:parsed.data},ledger.error.code);return fail('โหลดประวัติแต้มไม่สำเร็จ',502);}
  log(scope,'info','customerDetail','โหลดรายละเอียดลูกค้า',{customerId:parsed.data,canLedger:scope.canLedger});
  return ok({customer:customerDto(result.data,account.data?.points_balance??0),canLedger:scope.canLedger,ledger:ledger.data??[]});
 }

 // receipt
 const parsed=z.object({orderId:id}).strict().safeParse(body);if(!parsed.success)return fail('รหัสใบเสร็จไม่ถูกต้อง');
 const orderId=parsed.data.orderId;
 const order=await getOrder(orderId);
 if(order.error){log(scope,'error','receiptClaim','ตรวจใบเสร็จไม่สำเร็จ',{orderId},order.error.code);return fail('ตรวจใบเสร็จไม่สำเร็จ',502);}
 if(!order.data||order.data.storeId!==scope.storeId||order.data.organizationId!==scope.organizationId)return fail('ไม่พบบิลในร้านนี้',404);
 if(order.data.status!=='paid')return fail('บิลนี้ยังไม่ใช่ใบเสร็จที่ชำระแล้ว',409);
 const result=await getReceiptLoyaltyClaimAction(orderId);
 if(result.error){log(scope,'error','receiptClaim','สร้าง QR รับแต้มไม่สำเร็จ',{orderId,reason:result.error});return fail(result.error,502);}
 if(!result.claim){log(scope,'info','receiptClaim','ใบเสร็จนี้ไม่มี QR รับแต้ม',{orderId});return ok({orderId,claim:null,error:null});}
 // Never render a receipt QR to an origin outside this authenticated backend.
 let claimUrl:URL;try{claimUrl=new URL(result.claim.url);}catch{log(scope,'error','receiptClaim','ลิงก์รับแต้มไม่ถูกต้อง',{orderId});return fail('ลิงก์รับแต้มไม่ถูกต้อง',502);}
 if(claimUrl.origin!==url.origin||!claimUrl.pathname.startsWith('/member/')){log(scope,'error','receiptClaim','ปลายทางรับแต้มไม่ตรงกับเซิร์ฟเวอร์',{orderId,claimOrigin:claimUrl.origin,requestOrigin:url.origin});return fail('ปลายทางรับแต้มไม่ตรงกับร้าน',502);}
 const imageUri=await QRCode.toDataURL(claimUrl.href,{errorCorrectionLevel:'M',margin:4,width:384});
 log(scope,'info','receiptClaim','ออก QR รับแต้มบนใบเสร็จ',{orderId,points:result.claim.points});
 return ok({orderId,claim:{points:result.claim.points,expiresAt:result.claim.expiresAt,imageUri},error:null});
}
