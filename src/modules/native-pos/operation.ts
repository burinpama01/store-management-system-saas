import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServiceClient } from '@/server/integrations/supabase/server';
import { getNativeRequestContext } from './request-context';
import type { CreateOrderInput } from '@/modules/pos/order-repository';
import { generateOrderNumber } from '@/modules/pos/order-number';
import { mapError } from '@/shared/utils/error';
export function nativeOperationKey(userId: string, storeId: string, operationId: string) {
  return `native:${storeId}:${userId}:${operationId}`;
}
export async function createNativeOrderIds(input: CreateOrderInput, operationKey: string) {
  const scope = getNativeRequestContext();
  if (!scope || scope.user.id !== input.cashierId || scope.storeId !== input.storeId) throw new Error('ไม่พบคำขอ native ที่ตรวจสิทธิ์แล้ว');
  if (!Number.isSafeInteger(scope.expectedTotalSatang) || scope.expectedTotalSatang !== Math.round(input.cart.total * 100)) {
    throw new Error('ราคาสินค้าเปลี่ยน กรุณาโหลดรายการใหม่และตรวจยอดก่อนรับเงิน');
  }
  const client = await createSupabaseServiceClient() as unknown as SupabaseClient;
  const orderNumber = generateOrderNumber({ timeZone: input.storeTimezone });
  const items = input.cart.items.map(item => ({ product_id: item.productId, product_name: item.productName, variant_id: item.variant?.id ?? null, variant_name: item.variant?.name ?? null, modifiers: item.modifiers, quantity: item.quantity, unit_price: item.unitPrice, total_price: item.totalPrice, discount_amount: 0, note: item.note ?? null }));
  const result = await client.rpc('create_native_pos_order', { p_store_id: input.storeId, p_key: operationKey, p_actor_id: scope.user.id, p_order_number: orderNumber, p_total: input.cart.total, p_items: items });
  if (result.error || !result.data) return { data: null, error: mapError(result.error ?? new Error('สร้างบิล native ไม่สำเร็จ')) };
  return { data: { id: result.data as string, orderNumber }, error: null };
}
export async function cancelNativeOperation(storeId: string, userId: string, operationId: string) {
  const scope = getNativeRequestContext();
  if (!scope || scope.user.id !== userId || scope.storeId !== storeId) throw new Error('ไม่พบคำขอ native ที่ตรวจสิทธิ์แล้ว');
  const client = await createSupabaseServiceClient() as unknown as SupabaseClient;
  const result = await client.rpc('cancel_native_pos_operation', { p_store_id: storeId, p_key: nativeOperationKey(userId, storeId, operationId), p_actor_id: scope.user.id });
  if (result.error) throw new Error('ยืนยันคำขอค้างไม่ได้ กรุณาตรวจว่า native operation migration พร้อมใช้งานแล้ว');
  const value = result.data as { outcome?: string; orderId?: string } | null;
  if (value?.outcome === 'not_created') return { outcome: 'not_created' as const };
  if (value?.outcome === 'existing' && value.orderId) return { outcome: 'existing' as const, orderId: value.orderId };
  throw new Error('ผลตรวจสอบคำขอไม่ถูกต้อง');
}
export async function findNativeOrderId(organizationId: string, storeId: string, userId: string, operationId: string): Promise<string | null> {
  // This table exists in 20260621040000; generated Database has not included it yet.
  const client = await createSupabaseServiceClient() as unknown as SupabaseClient;
  const result = await client.from('pos_order_idempotency_keys').select('order_id').eq('organization_id', organizationId).eq('store_id', storeId).eq('idempotency_key', nativeOperationKey(userId, storeId, operationId)).maybeSingle();
  if (result.error) throw new Error('ไม่สามารถตรวจสอบบิลเดิมได้');
  if (!result.data) return null;
  const order = await client.from('orders').select('id').eq('id', result.data.order_id).eq('organization_id', organizationId).eq('store_id', storeId).eq('cashier_id', userId).maybeSingle();
  if (order.error || !order.data) throw new Error('ไม่สามารถยืนยันเจ้าของบิลเดิม');
  return order.data.id as string;
}
