import type { NativeLine } from '../../../../src/modules/native-pos/contracts';
import { addLine, emptyDraft, restoreDraft, type Draft } from './cart';
export const workflowBlocked = (draft: Draft | null) => !!(draft?.parking || draft?.resuming);
export function cashAmount(raw: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) throw new Error('กรอกจำนวนเงินบาท ไม่เกิน 2 ตำแหน่งทศนิยม');
  const [whole, fraction = ''] = raw.trim().split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 1000000000) throw new Error('ยอดเงินต้องไม่เกิน 10,000,000 บาท');
  return amount;
}
export function startParking(draft: Draft, label: string, id: string, pendingCheckout: boolean): Draft {
  if (pendingCheckout || workflowBlocked(draft) || draft.checkoutOperationId || !draft.lines.length) throw new Error('บิลนี้พักไม่ได้ กรุณาตรวจผลชำระหรือขายบิลที่เรียกกลับให้เสร็จก่อน');
  const next = { ...draft, parking: { id, label: label.trim() } };
  if (!restoreDraft(JSON.stringify(next), draft.storeId, draft.userId)) throw new Error('ชื่อหรือรหัสบิลพักไม่ถูกต้อง');
  return next;
}
export function finishParking(draft: Draft, id: string) {
  if (!draft.parking || draft.parking.id !== id) throw new Error('ผลพักบิลไม่ตรงกับคำขอ');
  return emptyDraft(draft.storeId, draft.userId);
}
export function startResuming(draft: Draft, ticket: { id: string; updatedAt: string }, claimId: string, pendingCheckout: boolean): Draft {
  if (pendingCheckout || workflowBlocked(draft) || draft.lines.length || draft.checkoutOperationId) throw new Error('กรุณาขายหรือพักบิลปัจจุบันก่อนเรียกบิลกลับ');
  const next = { ...draft, resuming: { ...ticket, claimId } };
  if (!restoreDraft(JSON.stringify(next), draft.storeId, draft.userId)) throw new Error('บิลพักไม่ถูกต้อง');
  return next;
}
export function finishResuming(draft: Draft, result: { id: string; checkoutOperationId: string; lines: NativeLine[] }): Draft {
  if (!draft.resuming || result.id !== draft.resuming.id || result.checkoutOperationId !== draft.resuming.claimId || !Array.isArray(result.lines) || !result.lines.length) throw new Error('ผลเรียกบิลไม่ตรงกับคำขอ');
  const next = result.lines.reduce(addLine, emptyDraft(draft.storeId, draft.userId));
  next.checkoutOperationId = result.checkoutOperationId;
  return next;
}
