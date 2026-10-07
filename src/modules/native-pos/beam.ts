import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServiceClient } from '@/server/integrations/supabase/server';
import { createBeamQrPayment, refreshBeamPayment, getBeamConfig } from '@/modules/payments/beam-service';
import { createBeamQrCharge } from '@/modules/payments/beam-client';
import type { NativeBeamQr, NativeBeamStatus } from './contracts';
export interface NativeBeamScope { storeId: string; organizationId: string; userId: string }
type Row = { id: string; store_id: string; organization_id: string; provider_config_id: string; amount: number | string; storeos_reference: string; metadata: Record<string, unknown> | null; status: NativeBeamStatus; order_id: string | null; pos_payment_id: string | null; provider_payment_id: string | null; injected_emv_payload: string | null };
export function nativeBeamRequestId(scope: NativeBeamScope, operationId: string) {
 const hex=createHash('sha256').update(JSON.stringify(['native-beam-v1',scope.storeId,scope.userId,operationId])).digest('hex').slice(0,32).split('');hex[12]='4';hex[16]='8';const s=hex.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
async function lookup(scope:NativeBeamScope, field:'id'|'storeos_reference',value:string):Promise<Row|null>{
 const service=await createSupabaseServiceClient() as unknown as SupabaseClient;
 const result=await service.from('gateway_payments').select('id,store_id,organization_id,provider_config_id,amount,storeos_reference,metadata,status,order_id,pos_payment_id,provider_payment_id,injected_emv_payload').eq('organization_id',scope.organizationId).eq('store_id',scope.storeId).eq('provider_key','beam').eq(field,value).maybeSingle();
 if(result.error)throw new Error('ตรวจรายการ Beam เดิมไม่สำเร็จ กรุณาตรวจรายการเดิมก่อนเริ่มใหม่');return result.data as Row|null;
}
function verify(row:Row|null,scope:NativeBeamScope,operationId:string,totalSatang:number):asserts row is Row{
 if(!row||row.store_id!==scope.storeId||row.organization_id!==scope.organizationId||row.metadata?.createdBy!==scope.userId||row.storeos_reference!==`beam:${nativeBeamRequestId(scope,operationId)}`)throw new Error('ไม่พบรายการ Beam ที่ตรงกับคำขอและผู้ใช้ในร้านนี้');
 if(!Number.isSafeInteger(totalSatang)||totalSatang<100||Math.round(Number(row.amount)*100)!==totalSatang)throw new Error('ยอด Beam ไม่ตรงกับบิลเดิม');
 if(row.pos_payment_id||row.order_id)throw new Error('Beam ผูกกับบิลแล้ว กรุณาตรวจบิลเดิมใน StoreOS');
}
async function image(payload:string|null,base64:string|null=null):Promise<string|null>{
 if(payload){if(payload.length>10000)throw new Error('ข้อมูล QR ใหญ่เกินขอบเขต');return QRCode.toDataURL(payload,{errorCorrectionLevel:'M',width:400,margin:4});}
 if(base64){const value=base64.replace(/^data:image\/png;base64,/,'');if(value.length>2000000||!/^iVBORw0KGgo[A-Za-z0-9+/=\r\n]+$/.test(value))throw new Error('รูป QR Beam ไม่ถูกต้อง');return `data:image/png;base64,${value}`;}
 return null;
}
export async function checkNativeBeam(scope:NativeBeamScope,operationId:string,gatewayPaymentId:string,totalSatang:number):Promise<NativeBeamQr>{
 const row=await lookup(scope,'id',gatewayPaymentId);verify(row,scope,operationId,totalSatang);
 const result=await refreshBeamPayment({storeId:scope.storeId,gatewayPaymentId,minLookupIntervalMs:5000});
 if(!result.ok)throw new Error(result.error);if(Math.round(result.amount*100)!==totalSatang)throw new Error('ยอด Beam เปลี่ยน กรุณาตรวจรายการเดิม');
 return {gatewayPaymentId,totalSatang,status:result.status,imageUri:await image(row.injected_emv_payload),expiresAt:typeof row.metadata?.expiresAt==='string'?row.metadata.expiresAt:null};
}
export async function prepareNativeBeam(scope:NativeBeamScope,operationId:string,totalSatang:number):Promise<NativeBeamQr>{
 if(!Number.isSafeInteger(totalSatang)||totalSatang<100)throw new Error('ยอด Beam ต้องอย่างน้อย 1 บาท');
 const clientRequestId=nativeBeamRequestId(scope,operationId);
 const existing=await lookup(scope,'storeos_reference',`beam:${clientRequestId}`);
 if(existing){
   verify(existing,scope,operationId,totalSatang);
   if(existing.provider_payment_id||existing.status==='PAID'){
     const qr=await checkNativeBeam(scope,operationId,existing.id,totalSatang);
     const expiresAt=typeof existing.metadata?.expiresAt==='string'?existing.metadata.expiresAt:null;
     if(!qr.imageUri&&['CREATED','PENDING','REQUIRES_ACTION','PROCESSING'].includes(qr.status)&&expiresAt&&Date.parse(expiresAt)>Date.now()){
       // Recover an image-only response with exactly the original provider idempotency key,
       // amount, reference and expiry. Never insert a gateway row or refresh its expiry.
       const config=await getBeamConfig(scope.storeId);
       if(!config?.creds||config.id!==existing.provider_config_id||config.environment!==existing.metadata?.environment)throw new Error('การตั้งค่า Beam เปลี่ยน กรุณาตรวจรายการเดิมใน StoreOS');
       const recovered=await createBeamQrCharge({environment:config.environment,creds:config.creds,amountSatang:totalSatang,referenceId:existing.id,idempotencyKey:existing.id,expiresAt});
       if(!recovered.ok)throw new Error(recovered.error);
       if(recovered.data.chargeId!==existing.provider_payment_id)throw new Error('Beam คืนรายการไม่ตรงกับ charge เดิม');
       return {...qr,imageUri:await image(recovered.data.qrPayload,recovered.data.qrImageBase64)};
     }
     return qr;
   }
   if(!['CREATED','PENDING','REQUIRES_ACTION','PROCESSING'].includes(existing.status))throw new Error('ผล Beam ต้องตรวจใน StoreOS กรุณาไม่สร้างคำขอใหม่');
 }
 const result=await createBeamQrPayment({...scope,actorUserId:scope.userId,clientRequestId,amountMajor:totalSatang/100});
 if(!result.ok)throw new Error(result.error);if(Math.round(result.qr.amount*100)!==totalSatang)throw new Error('ยอด QR ไม่ตรงกับบิล');
 return {gatewayPaymentId:result.qr.gatewayPaymentId,totalSatang,status:result.qr.status,imageUri:await image(result.qr.qrPayload,result.qr.qrImageBase64),expiresAt:result.qr.expiresAt};
}
