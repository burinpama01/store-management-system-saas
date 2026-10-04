import { describe, expect, it } from 'vitest';
import { addLine, emptyDraft, totalSatang, restoreDraft, acceptAiProposal, setQuantity } from '../src/domain/cart';
import { availableDeliveryActions, deliveryLabel } from '../src/domain/delivery';
import { choosePrintRoute, runPrintJob } from '../src/domain/printing';

const line = { key: 'latte', productId: 'latte', name: 'ลาเต้', quantity: 2, unitSatang: 6550, variantId: null, optionIds: [], note: '' };
describe('cart safety and recovery', () => {
  it('calculates money in satang and merges only identical choices', () => {
    const draft = addLine(addLine(emptyDraft('store-a', 'user-a'), line), { ...line, quantity: 1 });
    expect(draft.lines).toHaveLength(1);
    expect(totalSatang(draft)).toBe(19650);
    expect(addLine(draft, { ...line, key: 'other', note: 'แยกน้ำแข็ง' }).lines).toHaveLength(2);
  });
  it('rejects invalid quantities rather than corrupting a persisted bill', () => {
    const draft = addLine(emptyDraft('a', 'u'), line);
    expect(() => setQuantity(draft, 'latte', Number.NaN)).toThrow();
    expect(() => addLine(draft, { ...line, quantity: 0 })).toThrow();
    expect(() => addLine(draft, { ...line, unitSatang: -1 })).toThrow();
  });
  it('restores only the same user and store and fails closed on malformed data', () => {
    const draft = addLine(emptyDraft('a', 'u'), line);
    expect(restoreDraft(JSON.stringify(draft), 'a', 'u')?.lines).toHaveLength(1);
    expect(restoreDraft(JSON.stringify(draft), 'b', 'u')).toBeNull();
    expect(restoreDraft(JSON.stringify(draft), 'a', 'other')).toBeNull();
    expect(restoreDraft('{broken', 'a', 'u')).toBeNull();
    expect(restoreDraft(JSON.stringify({ ...draft, lines: [{ ...line, unitSatang: '12' }] }), 'a', 'u')).toBeNull();
  });
  it('does not apply an AI answer after a cart or store changed', () => {
    const draft = emptyDraft('a', 'u');
    const changed = addLine(draft, line);
    expect(() => acceptAiProposal(changed, { storeId: 'a', revision: draft.revision, lines: [line] })).toThrow('รายการเปลี่ยน');
    expect(() => acceptAiProposal(draft, { storeId: 'b', revision: draft.revision, lines: [line] })).toThrow();
    expect(acceptAiProposal(draft, { storeId: 'a', revision: draft.revision, lines: [line] }).lines).toHaveLength(1);
  });
});
describe('JDC compatibility', () => {
  it('allows cancellation before acceptance and never allows cashier completion', () => {
    expect(availableDeliveryActions('received')).toEqual(['accepted', 'cancelled']);
    expect(availableDeliveryActions('accepted')).toEqual(['preparing']);
    expect(availableDeliveryActions('preparing')).toEqual(['ready']);
    expect(availableDeliveryActions('ready')).toEqual([]);
    expect(availableDeliveryActions('completed')).toEqual([]);
    expect(deliveryLabel('completed')).not.toContain('ลูกค้าได้รับ');
  });
});
describe('printer selection and uncertain writes', () => {
  it('does not pretend iOS can print to generic SPP or USB directly', () => {
    expect(choosePrintRoute({ transport: 'classic', protocol: 'escpos', tested: true }, 'ios', ['tcp', 'system'])).toBe('unsupported');
    expect(choosePrintRoute({ transport: 'usb', protocol: 'escpos', tested: true }, 'ios', ['hub'])).toBe('unsupported');
    expect(choosePrintRoute({ transport: 'hub', protocol: 'escpos', tested: true }, 'ios', ['hub'])).toBe('hub');
    expect(choosePrintRoute({ transport: 'lan', protocol: 'escpos', tested: false }, 'ios', ['tcp'])).toBe('needs-test');
  });
  it('does not retry after a driver may have sent bytes', async () => {
    let calls = 0;
    const result = await runPrintJob(async () => { calls++; throw new Error('timeout'); });
    expect(result.state).toBe('unknown');
    expect(calls).toBe(1);
    expect((await runPrintJob(async () => ({ confirmed: false }))).state).toBe('submitted');
  });
});
