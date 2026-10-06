import { expect, it } from 'vitest';
import { emptyDraft, addLine, restoreDraft } from '../src/domain/cart';
import { cashAmount, startParking, finishParking, startResuming, finishResuming, workflowBlocked } from '../src/domain/workflow';
const ticketId = 'aaaaaaaa-1111-4111-8111-111111111111';
const claimId = 'bbbbbbbb-1111-4111-8111-111111111111';
const item = { key: 'k', productId: 'p', name: 'กาแฟ', quantity: 1, unitSatang: 4500, variantId: null, optionIds: [], note: '' };
it('parses decimal money without truncation or exponent', () => {
  expect(cashAmount('45.25')).toBe(4525); expect(cashAmount('0')).toBe(0);
  for (const value of ['-1', '1e3', '1.001', '12abc', '', '10000000.01']) expect(() => cashAmount(value)).toThrow();
});
it('persists stable park intent and locks mutations until server confirms', () => {
  const draft = addLine(emptyDraft('store','user'), item);
  const waiting = startParking(draft, 'บิลลูกค้า', ticketId, false);
  expect(workflowBlocked(waiting)).toBe(true);
  expect(restoreDraft(JSON.stringify(waiting), 'store','user')?.parking?.id).toBe(ticketId);
  expect(() => startParking(waiting,'new',claimId,false)).toThrow();
  expect(() => finishParking(waiting, claimId)).toThrow();
  expect(finishParking(waiting,ticketId).lines).toHaveLength(0);
});
it('never parks a pending checkout or a claimed ticket', () => {
  const draft = addLine(emptyDraft('store','user'), item);
  expect(() => startParking(draft,'bill',ticketId,true)).toThrow();
  expect(() => startParking({...draft,checkoutOperationId:claimId},'bill',ticketId,false)).toThrow();
});
it('resumes only into an empty draft and reuses a durable operation id', () => {
  const draft = emptyDraft('store','user');
  expect(() => startResuming(addLine(draft,item),{id:ticketId,updatedAt:'2026-10-06T00:00:00Z'},claimId,false)).toThrow();
  const waiting = startResuming(draft,{id:ticketId,updatedAt:'2026-10-06T00:00:00Z'},claimId,false);
  expect(restoreDraft(JSON.stringify(waiting),'store','user')?.resuming?.claimId).toBe(claimId);
  expect(() => finishResuming(waiting,{id:ticketId,checkoutOperationId:ticketId,lines:[item]})).toThrow();
  const resumed = finishResuming(waiting,{id:ticketId,checkoutOperationId:claimId,lines:[item]});
  expect(resumed.checkoutOperationId).toBe(claimId); expect(resumed.lines).toEqual([item]);
  expect(workflowBlocked(resumed)).toBe(false);
});
it('rejects tampered persistent workflow metadata', () => {
  expect(restoreDraft(JSON.stringify({...emptyDraft('store','user'),checkoutOperationId:'bad'}),'store','user')).toBeNull();
  expect(restoreDraft(JSON.stringify({...emptyDraft('store','user'),parking:{id:ticketId,label:'ok'},resuming:{id:ticketId,updatedAt:'x',claimId}}),'store','user')).toBeNull();
});
