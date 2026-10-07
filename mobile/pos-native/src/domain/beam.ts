import type { NativeBeamQr, NativeCheckoutInput } from '../../../../src/modules/native-pos/contracts';
export type PendingPayment = { operationId:string; input:NativeCheckoutInput; state:'sending'|'unknown'|'partial'|'beam_creating'|'beam_waiting'; orderId?:string|null; beam?:NativeBeamQr };
export const isBeamPending=(pending:PendingPayment|null)=>pending?.input.method==='beam';
export function restoreBeamPending(value:unknown):PendingPayment {
 const p=value as PendingPayment;
 if(!p||!p.input||p.input.method!=='beam'||p.operationId!==p.input.operationId||!p.operationId||!['beam_creating','beam_waiting','sending','unknown','partial'].includes(p.state)||!Number.isSafeInteger(p.input.expectedTotalSatang)||p.input.expectedTotalSatang<100||!Array.isArray(p.input.lines)||!p.input.lines.length)throw new Error('รายการ Beam ที่เก็บไว้ไม่สมบูรณ์ กรุณาตรวจรายการเดิมใน StoreOS');
 if(p.beam && (p.beam.totalSatang!==p.input.expectedTotalSatang||p.beam.gatewayPaymentId!==p.input.gatewayPaymentId))throw new Error('รายการ Beam ไม่ตรงกับบิลที่เก็บไว้');
 return p;
}
export function advanceBeam(pending:PendingPayment,qr:NativeBeamQr):PendingPayment{
 if(pending.input.method!=='beam'||qr.totalSatang!==pending.input.expectedTotalSatang||((pending.input.gatewayPaymentId??pending.beam?.gatewayPaymentId)&&(pending.input.gatewayPaymentId??pending.beam?.gatewayPaymentId)!==qr.gatewayPaymentId))throw new Error('QR ไม่ตรงกับรายการชำระเดิม');
 return {...pending,beam:{...qr,imageUri:qr.imageUri??pending.beam?.imageUri??null},input:{...pending.input,gatewayPaymentId:qr.gatewayPaymentId},state:qr.status==='PAID'?'sending':'beam_waiting'};
}
export async function startBeam(input:NativeCheckoutInput,persist:(pending:PendingPayment)=>Promise<void>,prepare:(input:NativeCheckoutInput)=>Promise<NativeBeamQr>):Promise<PendingPayment>{
 const pending:PendingPayment={operationId:input.operationId,input:{...input,lines:input.lines.map(l=>({...l,optionIds:[...l.optionIds]}))},state:'beam_creating'};
 restoreBeamPending(pending);await persist(pending);return advanceBeam(pending,await prepare(pending.input));
}
