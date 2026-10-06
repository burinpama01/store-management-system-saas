import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@/server/integrations/supabase/database.types';
const mocks = vi.hoisted(() => ({ service: vi.fn(), rpc: vi.fn() }));
vi.mock('@/server/integrations/supabase/server', () => ({ createSupabaseServiceClient: mocks.service }));
vi.mock('@/modules/pos/order-number', () => ({ generateOrderNumber: () => 'POS-TEST' }));
import { cancelNativeOperation, createNativeOrderIds, nativeOperationKey } from '@/modules/native-pos/operation';
import { withNativeRequestContext } from '@/modules/native-pos/request-context';
const userId = '10000000-0000-4000-8000-000000000001', storeId = '20000000-0000-4000-8000-000000000002', operationId = '30000000-0000-4000-8000-000000000003';
const scope = { user: { id: userId } as User, storeId, client: {} as SupabaseClient<Database>, expectedTotalSatang: 6500 };
const input = { storeId, organizationId: 'org', cashierId: userId, cart: { storeId, items: [], subtotal: 65, discount: 0, total: 65 } };
beforeEach(() => { vi.clearAllMocks(); mocks.service.mockResolvedValue({ rpc: mocks.rpc }); });
it('rejects changed or missing confirmed total before any order RPC', async () => {
  for (const expectedTotalSatang of [6600, undefined]) {
    await expect(withNativeRequestContext({ ...scope, expectedTotalSatang }, () => createNativeOrderIds(input, 'key'))).rejects.toThrow('ราคาสินค้าเปลี่ยน');
  }
  expect(mocks.service).not.toHaveBeenCalled();
});
it('rejects missing or mismatched verified actor before constructing a privileged client', async () => {
  await expect(createNativeOrderIds(input, 'key')).rejects.toThrow();
  await expect(withNativeRequestContext(scope, () => cancelNativeOperation(storeId, 'someone-else', operationId))).rejects.toThrow();
  expect(mocks.service).not.toHaveBeenCalled();
});
it('sends only the scoped actor to server-only create and cancellation RPCs', async () => {
  mocks.rpc.mockResolvedValueOnce({ data: 'order-id', error: null });
  const key = nativeOperationKey(userId, storeId, operationId);
  expect(key).toBe(`native:${storeId}:${userId}:${operationId}`);
  await withNativeRequestContext(scope, () => createNativeOrderIds(input, key));
  expect(mocks.rpc).toHaveBeenLastCalledWith('create_native_pos_order', expect.objectContaining({ p_actor_id: userId, p_store_id: storeId, p_key: key }));
  mocks.rpc.mockResolvedValueOnce({ data: { outcome: 'not_created' }, error: null });
  await expect(withNativeRequestContext(scope, () => cancelNativeOperation(storeId, userId, operationId))).resolves.toEqual({ outcome: 'not_created' });
  expect(mocks.rpc).toHaveBeenLastCalledWith('cancel_native_pos_operation', { p_actor_id: userId, p_store_id: storeId, p_key: key });
});
it('fails closed on missing migration or an unexpected cancellation result', async () => {
  mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'function missing' } });
  await expect(withNativeRequestContext(scope, () => cancelNativeOperation(storeId, userId, operationId))).rejects.toThrow();
  mocks.rpc.mockResolvedValueOnce({ data: { outcome: 'unknown' }, error: null });
  await expect(withNativeRequestContext(scope, () => cancelNativeOperation(storeId, userId, operationId))).rejects.toThrow();
});
