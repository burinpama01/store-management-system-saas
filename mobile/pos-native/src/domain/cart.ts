import type { NativeLine } from '../../../../src/modules/native-pos/contracts';
export interface Draft { version: 1; storeId: string; userId: string; revision: number; lines: NativeLine[]; checkoutOperationId?: string; parking?: { id: string; label: string }; resuming?: { id: string; updatedAt: string; claimId: string } }
export const emptyDraft = (storeId: string, userId: string): Draft => ({ version: 1, storeId, userId, revision: 0, lines: [] });
function validate(line: NativeLine) {
  if (!line || typeof line.key !== 'string' || !line.key || typeof line.productId !== 'string' || !line.productId || typeof line.name !== 'string' || typeof line.note !== 'string' || !Array.isArray(line.optionIds) || !line.optionIds.every(id => typeof id === 'string') || (line.variantId !== null && typeof line.variantId !== 'string') || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 999 || !Number.isSafeInteger(line.unitSatang) || line.unitSatang < 0 || line.unitSatang > 100000000) throw new Error('รายการสินค้าไม่ถูกต้อง');
}
export function totalSatang(draft: Draft) { const total = draft.lines.reduce((sum, line) => { validate(line); return sum + line.quantity * line.unitSatang; }, 0); if (!Number.isSafeInteger(total)) throw new Error('ยอดเกินขอบเขต'); return total; }
export function addLine(draft: Draft, line: NativeLine): Draft {
  if (draft.parking || draft.resuming) throw new Error('ตรวจผลบิลพักก่อนแก้รายการ');
  validate(line);
  const existing = draft.lines.find(item => item.key === line.key);
  if (existing && JSON.stringify({ ...existing, quantity: 0 }) !== JSON.stringify({ ...line, quantity: 0 })) throw new Error('ตัวเลือกรายการไม่ตรงกัน');
  const merged = { ...line, quantity: (existing?.quantity ?? 0) + line.quantity }; validate(merged);
  if (!existing && draft.lines.length >= 100) throw new Error('สูงสุด 100 รายการต่อบิล');
  return { ...draft, revision: draft.revision + 1, lines: existing ? draft.lines.map(item => item.key === line.key ? merged : item) : [...draft.lines, { ...line, optionIds: [...line.optionIds] }] };
}
export function setQuantity(draft: Draft, key: string, quantity: number): Draft {
  if (draft.parking || draft.resuming) throw new Error('ตรวจผลบิลพักก่อนแก้รายการ');
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 999) throw new Error('จำนวนไม่ถูกต้อง');
  return { ...draft, revision: draft.revision + 1, lines: draft.lines.flatMap(line => line.key === key ? quantity ? [{ ...line, quantity }] : [] : [line]) };
}
export function restoreDraft(raw: string | null, storeId: string, userId: string): Draft | null {
  try {
    const draft = JSON.parse(raw ?? 'null') as Draft;
    if (!draft || draft.version !== 1 || draft.storeId !== storeId || draft.userId !== userId || !Number.isSafeInteger(draft.revision) || draft.revision < 0 || !Array.isArray(draft.lines) || draft.lines.length > 100 || new Set(draft.lines.map(line => line.key)).size !== draft.lines.length) return null;
    const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
    if (draft.checkoutOperationId !== undefined && !uuid(draft.checkoutOperationId)) return null;
    if (draft.parking && (!uuid(draft.parking.id) || typeof draft.parking.label !== 'string' || !draft.parking.label.trim() || draft.parking.label.length > 80 || !draft.lines.length || draft.checkoutOperationId)) return null;
    if (draft.resuming && (!uuid(draft.resuming.id) || !uuid(draft.resuming.claimId) || typeof draft.resuming.updatedAt !== 'string' || !Number.isFinite(Date.parse(draft.resuming.updatedAt)) || draft.lines.length || draft.checkoutOperationId)) return null;
    if (draft.parking && draft.resuming) return null;
    totalSatang(draft); return draft;
  } catch { return null; }
}
export function acceptAiProposal(draft: Draft, proposal: { storeId: string; revision: number; lines: NativeLine[] }): Draft {
  if (proposal.storeId !== draft.storeId || proposal.revision !== draft.revision) throw new Error('รายการเปลี่ยน กรุณาขอคำแนะนำใหม่');
  return proposal.lines.reduce(addLine, draft);
}
