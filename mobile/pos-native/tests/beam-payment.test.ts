import { expect, it, vi } from 'vitest';
import { startBeam, restoreBeamPending, advanceBeam } from '../src/domain/beam';
const input:any={operationId:'30000000-0000-4000-8000-000000000003',method:'beam',expectedTotalSatang:6500,receivedSatang:6500,lines:[{productId:'p',quantity:1,variantId:null,optionIds:[],note:''}]};
const qr:any={gatewayPaymentId:'g',totalSatang:6500,status:'PENDING',imageUri:'data:image/png;base64,AA==',expiresAt:null};
it('persists a frozen intent before any provider call and restores it',async()=>{
 const events:string[]=[];const pending=await startBeam(input,async()=>{events.push('persist')},async()=>{events.push('provider');return qr});expect(events).toEqual(['persist','provider']);expect(pending.state).toBe('beam_waiting');expect(restoreBeamPending(JSON.parse(JSON.stringify(pending)))).toEqual(pending);
});
it('never calls provider after a failed durable write',async()=>{const provider=vi.fn();await expect(startBeam(input,async()=>{throw Error('disk')},provider)).rejects.toThrow('disk');expect(provider).not.toHaveBeenCalled();});
it('rejects mismatched amount or replaced gateway and settles only PAID',()=>{
 const pending:any={operationId:input.operationId,input,state:'beam_waiting',beam:qr};expect(advanceBeam(pending,{...qr,status:'PAID'}).state).toBe('sending');expect(()=>advanceBeam(pending,{...qr,totalSatang:6000})).toThrow();expect(()=>advanceBeam(pending,{...qr,gatewayPaymentId:'other'})).toThrow();expect(advanceBeam(pending,{...qr,status:'REVIEW_REQUIRED'}).state).toBe('beam_waiting');
});
it('does not release a corrupt Beam intent as an empty cart',()=>{expect(()=>restoreBeamPending({operationId:input.operationId,input:{...input,method:'cash'},state:'beam_waiting'})).toThrow();});
