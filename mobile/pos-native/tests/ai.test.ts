import { describe, expect, it } from 'vitest';
import { resolveAiLines } from '../src/domain/ai';
const product = { id: 'p', name: 'บราวนี', priceSatang: 7500, categoryId: 'b', available: true, variants: [], groups: [] };
const envelope = { outcome: 'command_batch', confidence: 'high', commands: [{ intent: 'pos.add_item', productPhrase: 'บราวนี', quantity: 2, optionPhrases: [] }] };
describe('AI allowlisted proposals', () => {
  it('uses catalog prices and accepts only exact unambiguous names', () => {
    expect(resolveAiLines(envelope, [product])[0]).toMatchObject({ productId: 'p', quantity: 2, unitSatang: 7500 });
    expect(() => resolveAiLines(envelope, [product, { ...product, id: 'other' }])).toThrow();
    expect(() => resolveAiLines(envelope, [])).toThrow();
  });
  it('rejects low confidence, forbidden actions, unspecified quantity and omitted required modifiers', () => {
    expect(() => resolveAiLines({ ...envelope, confidence: 'low' }, [product])).toThrow();
    for (const intent of ['payment', 'pos.remove_item', 'navigate']) expect(() => resolveAiLines({ ...envelope, commands: [{ ...envelope.commands[0], intent }] }, [product])).toThrow();
    expect(() => resolveAiLines({ ...envelope, commands: [{ ...envelope.commands[0], quantity: null }] }, [product])).toThrow();
    expect(() => resolveAiLines(envelope, [{ ...product, groups: [{ id: 'g', name: 'เลือก', min: 1, max: 1, options: [] }] }])).toThrow();
  });
});
