import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({service:vi.fn(),read:vi.fn(),create:vi.fn(),refresh:vi.fn(),ready:vi.fn(),config:vi.fn(),recover:vi.fn()}));
vi.mock('@/modules/payments/beam-service',()=>({createBeamQrPayment:mocks.create,refreshBeamPayment:mocks.refresh,isBeamReadyForStore:mocks.ready,getBeamConfig:mocks.config}));
vi.mock('@/modules/payments/beam-client',()=>({createBeamQrCharge:mocks.recover}));
vi.mock('@/server/integrations/supabase/server',()=>({createSupabaseServiceClient:mocks.service}));
import { nativeBeamRequestId, prepareNativeBeam, checkNativeBeam } from '@/modules/native-pos/beam';
const scope={storeId:'store',organizationId:'org',userId:'user'};
const operationId='30000000-0000-4000-8000-000000000003';
beforeEach(()=>{vi.clearAllMocks();const query:any={select:()=>query,eq:()=>query,maybeSingle:mocks.read};mocks.service.mockResolvedValue({from:()=>query});mocks.read.mockResolvedValue({data:null,error:null});mocks.ready.mockResolvedValue(true);mocks.refresh.mockResolvedValue({ok:true,status:'PAID',amount:65});mocks.create.mockResolvedValue({ok:true,qr:{gatewayPaymentId:'gateway',amount:65,status:'PENDING',qrPayload:'sample',qrImageBase64:null,expiresAt:null}});});
it('binds provider request IDs to actor, store and operation',()=>{
 const id=nativeBeamRequestId(scope,operationId);expect(id).toMatch(/^[0-9a-f-]{36}$/);expect(id).toBe(nativeBeamRequestId(scope,operationId));expect(id).not.toBe(nativeBeamRequestId({...scope,userId:'other'},operationId));
});
it('creates only the server amount and returns a local image DTO',async()=>{
 const qr=await prepareNativeBeam(scope,operationId,6500);
 expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({storeId:'store',actorUserId:'user',amountMajor:65,clientRequestId:nativeBeamRequestId(scope,operationId)}));
 expect(qr).toMatchObject({totalSatang:6500,status:'PENDING'});expect(qr.imageUri).toMatch(/^data:image\/png;base64,/);
});
it('rejects foreign actor, operation and amounts before asking provider',async()=>{
 for(const patch of [{metadata:{createdBy:'other'}},{storeos_reference:'beam:other'},{amount:1},{pos_payment_id:'used'}]){
 mocks.read.mockResolvedValueOnce({data:{id:'gateway',organization_id:'org',store_id:'store',amount:65,storeos_reference:`beam:${nativeBeamRequestId(scope,operationId)}`,metadata:{createdBy:'user'},pos_payment_id:null,order_id:null,...patch},error:null});
 await expect(checkNativeBeam(scope,operationId,'gateway',6500)).rejects.toThrow();
 }expect(mocks.refresh).not.toHaveBeenCalled();
});
it('looks up a paid existing charge rather than creating another',async()=>{
 mocks.read.mockResolvedValue({data:{id:'gateway',provider_config_id:'config',organization_id:'org',store_id:'store',amount:65,status:'PAID',injected_emv_payload:null,provider_payment_id:'charge',storeos_reference:`beam:${nativeBeamRequestId(scope,operationId)}`,metadata:{createdBy:'user',environment:'live',expiresAt:new Date(Date.now()+60000).toISOString()},pos_payment_id:null,order_id:null},error:null});
 mocks.config.mockResolvedValue({id:'config',environment:'live',creds:{}});
 expect(await prepareNativeBeam(scope,operationId,6500)).toMatchObject({status:'PAID',gatewayPaymentId:'gateway'});expect(mocks.create).not.toHaveBeenCalled();expect(mocks.recover).not.toHaveBeenCalled();
});
it('recovers an image-only charge after the first response was lost using the same request ID',async()=>{
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
 const expiresAt=new Date(Date.now()+60000).toISOString();
 mocks.read.mockResolvedValue({data:{id:'gateway',provider_config_id:'config',organization_id:'org',store_id:'store',amount:65,status:'PENDING',provider_payment_id:'charge',injected_emv_payload:null,storeos_reference:`beam:${nativeBeamRequestId(scope,operationId)}`,metadata:{createdBy:'user',environment:'live',expiresAt},pos_payment_id:null,order_id:null},error:null});
 mocks.config.mockResolvedValue({id:'config',environment:'live',creds:{}});mocks.refresh.mockResolvedValue({ok:true,status:'PENDING',amount:65});mocks.recover.mockResolvedValue({ok:true,data:{chargeId:'charge',qrPayload:null,qrImageBase64:png}});
 const qr=await prepareNativeBeam(scope,operationId,6500);expect(qr.imageUri).toBe(`data:image/png;base64,${png}`);expect(qr.gatewayPaymentId).toBe('gateway');expect(mocks.create).not.toHaveBeenCalled();expect(mocks.recover).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:'gateway',referenceId:'gateway',amountSatang:6500,expiresAt}));
 mocks.create.mockClear();mocks.recover.mockClear();mocks.read.mockResolvedValue({data:{id:'gateway',organization_id:'org',store_id:'store',amount:65,status:'PENDING',provider_payment_id:'charge',injected_emv_payload:null,storeos_reference:`beam:${nativeBeamRequestId(scope,operationId)}`,metadata:{createdBy:'user',expiresAt:new Date(Date.now()-60000).toISOString()},pos_payment_id:null,order_id:null},error:null});
 expect(await prepareNativeBeam(scope,operationId,6500)).toMatchObject({imageUri:null});expect(mocks.create).not.toHaveBeenCalled();expect(mocks.recover).not.toHaveBeenCalled();
});
it('does not recover a charge after its provider configuration or environment changes',async()=>{
 mocks.read.mockResolvedValue({data:{id:'gateway',provider_config_id:'config',organization_id:'org',store_id:'store',amount:65,status:'PENDING',provider_payment_id:'charge',injected_emv_payload:null,storeos_reference:`beam:${nativeBeamRequestId(scope,operationId)}`,metadata:{createdBy:'user',environment:'live',expiresAt:new Date(Date.now()+60000).toISOString()},pos_payment_id:null,order_id:null},error:null});
 mocks.refresh.mockResolvedValue({ok:true,status:'PENDING',amount:65});
 for(const config of [{id:'changed',environment:'live',creds:{}},{id:'config',environment:'playground',creds:{}}]){
  mocks.config.mockResolvedValue(config);await expect(prepareNativeBeam(scope,operationId,6500)).rejects.toThrow();
 }
 expect(mocks.recover).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();
});
it('rejects a different provider charge ID during image recovery',async()=>{
 mocks.read.mockResolvedValue({data:{id:'gateway',provider_config_id:'config',organization_id:'org',store_id:'store',amount:65,status:'PENDING',provider_payment_id:'charge',injected_emv_payload:null,storeos_reference:`beam:${nativeBeamRequestId(scope,operationId)}`,metadata:{createdBy:'user',environment:'live',expiresAt:new Date(Date.now()+60000).toISOString()},pos_payment_id:null,order_id:null},error:null});
 mocks.config.mockResolvedValue({id:'config',environment:'live',creds:{}});mocks.refresh.mockResolvedValue({ok:true,status:'PENDING',amount:65});mocks.recover.mockResolvedValue({ok:true,data:{chargeId:'different',qrPayload:'sample',qrImageBase64:null}});
 await expect(prepareNativeBeam(scope,operationId,6500)).rejects.toThrow();expect(mocks.create).not.toHaveBeenCalled();
});
it('fails closed on lookup failures and changed refreshed amount',async()=>{
 mocks.read.mockResolvedValueOnce({data:null,error:{message:'db'}});await expect(prepareNativeBeam(scope,operationId,6500)).rejects.toThrow();expect(mocks.create).not.toHaveBeenCalled();
 mocks.read.mockResolvedValue({data:{id:'gateway',amount:65,organization_id:'org',store_id:'store',storeos_reference:`beam:${nativeBeamRequestId(scope,operationId)}`,metadata:{createdBy:'user'},pos_payment_id:null,order_id:null},error:null});mocks.refresh.mockResolvedValue({ok:true,status:'PAID',amount:60});await expect(checkNativeBeam(scope,operationId,'gateway',6500)).rejects.toThrow();
});
