import { describe, expect, it } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@/server/integrations/supabase/database.types';
import { getNativeRequestContext, withNativeRequestContext } from '@/modules/native-pos/request-context';
import { authoritativeCart } from '@/modules/native-pos/catalog';
import type { Product } from '@/modules/catalog/types';
import type { NativeCheckoutInput } from '@/modules/native-pos/contracts';

const product = { id: 'p1', storeId: 's1', name: 'ลาเต้', categoryId: 'c1', basePrice: 65.5, isActive: true, availableForPos: true, variants: [], modifierGroups: [] } as unknown as Product;
const input: NativeCheckoutInput = { operationId: 'operation', expectedTotalSatang: 19650, method: 'cash', receivedSatang: 20000, lines: [{ productId: 'p1', variantId: null, optionIds: [], quantity: 3, note: '' }] };
describe('native POS request isolation', () => {
  it('isolates clients, users and explicit stores across concurrent requests and cleans up after errors', async () => {
    const run = (id: string, delay: number) => withNativeRequestContext({ user: { id } as User, client: { tag: id } as unknown as SupabaseClient<Database>, storeId: id }, async () => { await new Promise(resolve => setTimeout(resolve, delay)); const ctx = getNativeRequestContext()!; return [ctx.user.id, ctx.storeId, (ctx.client as unknown as { tag: string }).tag]; });
    expect(await Promise.all([run('a', 20), run('b', 1)])).toEqual([['a', 'a', 'a'], ['b', 'b', 'b']]);
    expect(getNativeRequestContext()).toBeUndefined();
    expect(() => withNativeRequestContext({ user: {} as User, client: {} as SupabaseClient<Database>, storeId: null }, () => { throw new Error('test'); })).toThrow();
    expect(getNativeRequestContext()).toBeUndefined();
  });
});
describe('native authoritative pricing', () => {
  it('calculates using server catalog and rejects cross-store or disabled products', () => {
    expect(authoritativeCart('s1', input, [product]).total).toBe(196.5);
    expect(() => authoritativeCart('s2', input, [product])).toThrow();
    expect(() => authoritativeCart('s1', input, [{ ...product, outOfStock: true }])).toThrow();
  });
  it('rejects omitted required choices, unknown modifiers and duplicate options', () => {
    const withGroup = { ...product, modifierGroups: [{ id: 'sweet', name: 'ความหวาน', isRequired: true, selectionType: 'single', minSelections: 1, maxSelections: 1, options: [{ id: 'less', name: 'หวานน้อย', priceAdjustment: 5, isActive: true }] }] } as Product;
    expect(() => authoritativeCart('s1', input, [withGroup])).toThrow();
    const options = (optionIds: string[]) => ({ ...input, lines: [{ ...input.lines[0], optionIds }] });
    expect(authoritativeCart('s1', options(['less']), [withGroup]).total).toBe(211.5);
    expect(() => authoritativeCart('s1', options(['missing']), [withGroup])).toThrow();
    expect(() => authoritativeCart('s1', options(['less', 'less']), [withGroup])).toThrow();
  });
});
