import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Database } from '@/server/integrations/supabase/database.types';
import { createSupabaseServiceClient } from '@/server/integrations/supabase/server';
import { withNativeRequestContext } from '@/modules/native-pos/request-context';
import { getUserStores } from '@/modules/auth/session';
import { getResolvedCurrentPermissions } from '@/modules/auth/guards';
import { getOrganizationBillingState } from '@/modules/billing/billing-service';
import { hasBillingAccess } from '@/modules/billing/pricing';
import { listCategories, listProducts } from '@/modules/catalog/repository';
import { authoritativeCart, nativeProduct, satang } from '@/modules/native-pos/catalog';
import { checkoutAndPayAction, listTodayOrdersAction } from '@/app/pos/actions';
import { getConnectOrderById, getChannelLinkById, listChannelLinksByStore } from '@/modules/connect/repository';
import { applyPosStatus } from '@/modules/connect/status-sync';
import { POST as interpretVoice } from '@/app/api/ai/voice-intent/route';
import type { Order } from '@/modules/pos/types';
import type { NativeOrder } from '@/modules/native-pos/contracts';
import { findNativeOrderId, nativeOperationKey, cancelNativeOperation } from '@/modules/native-pos/operation';
import { getOrder } from '@/modules/pos/order-repository';

export const runtime = 'nodejs';
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
// PostgreSQL UUID columns also contain legacy IDs without RFC version/variant bits.
const databaseId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const checkoutSchema = z.object({ operationId: z.string().uuid(), expectedTotalSatang: z.number().int().min(0).max(10000000000), method: z.enum(['cash', 'bank_transfer']), receivedSatang: z.number().int().min(0).max(10000000000), lines: z.array(z.object({ productId: databaseId, variantId: databaseId.nullable(), optionIds: z.array(databaseId).max(50), quantity: z.number().int().min(1).max(999), note: z.string().max(500) }).strict()).min(1).max(100) }).strict();
function orderDto(order: Order): NativeOrder {
  return { id: order.id, number: order.orderNumber, status: order.status, totalSatang: satang(order.total), createdAt: order.createdAt,
    lines: order.items.map(item => ({ key: item.id, productId: item.productId, name: item.productName, quantity: item.quantity, unitSatang: satang(item.unitPrice), variantId: item.variantId ?? null, optionIds: item.modifiers.map(m => m.option.id), note: item.note ?? '' })) };
}
async function handle(request: Request, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return json({ error: 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่าการเชื่อมต่อ' }, 503);
  if (operation === 'config' && request.method === 'GET') return json({ supabaseUrl: url, publishableKey: key });
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) return json({ error: 'กรุณาเข้าสู่ระบบ' }, 401);
  const client = createClient<Database>(url, key, { global: { headers: { Authorization: `Bearer ${match[1]}` } }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.getUser(match[1]);
  if (error || !data.user) return json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' }, 401);
  const storeId = request.headers.get('x-store-id');
  if (storeId && !databaseId.safeParse(storeId).success) return json({ error: 'รหัสร้านไม่ถูกต้อง' }, 400);
  return withNativeRequestContext({ client, user: data.user, storeId }, async () => {
    try {
      const access = await getUserStores();
      const stores = access.stores.map(store => ({ id: store.id, name: store.name }));
      if (!storeId && operation === 'bootstrap' && request.method === 'GET') return json({ userId: data.user.id, stores, store: null, products: [], categories: [], permissions: { sell: false, delivery: false } });
      if (!storeId || !stores.some(store => store.id === storeId)) return json({ error: 'ไม่มีสิทธิ์เข้าถึงร้านนี้' }, 403);
      const { ctx, resolved } = await getResolvedCurrentPermissions();
      if (ctx.role !== 'super_admin') {
        const billing = await getOrganizationBillingState(ctx.organizationId);
        if (!billing || !hasBillingAccess(billing)) return json({ error: 'กรุณาตรวจสอบแพ็กเกจร้านก่อนใช้งาน' }, 403);
      }
      if (operation === 'bootstrap' && request.method === 'GET') {
        if (!resolved.can('pos.use')) return json({ error: 'ไม่มีสิทธิ์ใช้งาน POS' }, 403);
        const [products, categories] = await Promise.all([listProducts(storeId), listCategories(storeId)]);
        if (products.error || categories.error) return json({ error: 'โหลดรายการสินค้าไม่สำเร็จ' }, 502);
        return json({ userId: data.user.id, stores, store: stores.find(store => store.id === storeId), products: (products.data ?? []).map(nativeProduct), categories: (categories.data ?? []).map(c => ({ id: c.id, name: c.name })), permissions: { sell: resolved.can('pos.use'), delivery: resolved.can('orders.manage_qr') } });
      }
      if (operation === 'orders' && request.method === 'GET') {
        if (!resolved.can('pos.use')) return json({ error: 'ไม่มีสิทธิ์ใช้งาน POS' }, 403);
        const result = await listTodayOrdersAction();
        if (result.error) return json({ error: result.error }, 502);
        return json({ orders: result.orders.map(orderDto) });
      }
      if (operation === 'delivery' && request.method === 'GET') {
        if (!resolved.can('orders.manage_qr')) return json({ error: 'ไม่มีสิทธิ์จัดการเดลิเวอรี' }, 403);
        const page = Number(new URL(request.url).searchParams.get('page') ?? 0);
        if (!Number.isSafeInteger(page) || page < 0 || page > 10000) return json({ error: 'หน้าไม่ถูกต้อง' }, 400);
        const links = (await listChannelLinksByStore(storeId)).filter(link => link.channel === 'jdc' && link.organizationId === ctx.organizationId);
        if (!links.length) return json({ orders: [], nextPage: null });
        const service = await createSupabaseServiceClient();
        const result = await service.from('connect_orders').select('id,external_order_id,internal_order_id,fulfillment_status,received_at').eq('organization_id', ctx.organizationId).in('link_id', links.map(link => link.id)).order('received_at', { ascending: false }).order('id', { ascending: false }).range(page * 50, page * 50 + 50);
        if (result.error) return json({ error: 'โหลดออเดอร์ JDC ไม่สำเร็จ' }, 502);
        const rows = result.data ?? [];
        const ids = rows.flatMap(row => row.internal_order_id ? [row.internal_order_id] : []);
        const linked = ids.length ? await service.from('orders').select('id,order_number,total').eq('store_id', storeId).eq('organization_id', ctx.organizationId).in('id', ids) : { data: [], error: null };
        if (linked.error) return json({ error: 'โหลดบิลเดลิเวอรีไม่สำเร็จ' }, 502);
        const verifiedIds = (linked.data ?? []).map(order => order.id);
        const items = verifiedIds.length ? await service.from('order_items').select('id,order_id,product_id,product_name,variant_id,variant_name,quantity,unit_price,modifiers,note').in('order_id', verifiedIds) : { data: [], error: null };
        if (items.error) return json({ error: 'โหลดสินค้าเดลิเวอรีไม่สำเร็จ' }, 502);
        return json({ orders: rows.slice(0, 50).map(row => {
          const order = linked.data?.find(order => order.id === row.internal_order_id);
          return { id: row.id, externalId: row.external_order_id, internalOrderId: order?.id ?? null, number: order?.order_number ?? row.external_order_id, status: row.fulfillment_status, createdAt: row.received_at, totalSatang: satang(order?.total ?? 0), lines: (items.data ?? []).filter(item => item.order_id === order?.id).map(item => ({ key: item.id, productId: item.product_id, name: item.product_name, variantId: item.variant_id, quantity: item.quantity, unitSatang: satang(item.unit_price), optionIds: [], note: item.note ?? '', choiceLabel: [item.variant_name, ...(Array.isArray(item.modifiers) ? item.modifiers.flatMap(value => { const modifier = value as { option?: { name?: unknown } } | null; return typeof modifier?.option?.name === 'string' ? [modifier.option.name] : []; }) : [])].filter(Boolean).join(' · ') })) };
        }), nextPage: rows.length > 50 ? page + 1 : null });
      }
      if (request.method !== 'POST') return json({ error: 'ไม่พบรายการที่เรียก' }, 404);
      if (Number(request.headers.get('content-length') ?? 0) > 64000) return json({ error: 'ข้อมูลใหญ่เกินขอบเขต' }, 413);
      if (operation === 'voice') return interpretVoice(request);
      const raw = await request.text();
      if (raw.length > 64000) return json({ error: 'ข้อมูลใหญ่เกินขอบเขต' }, 413);
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return json({ error: 'ข้อมูลไม่ถูกต้อง' }, 400); }
      if (operation === 'cancel-operation') {
        if (!resolved.can('pos.use')) return json({ error: 'ไม่มีสิทธิ์ใช้งาน POS' }, 403);
        const parsed = z.object({ operationId: z.string().uuid() }).strict().safeParse(body);
        if (!parsed.success) return json({ error: 'รหัสคำขอไม่ถูกต้อง' }, 400);
        return json(await cancelNativeOperation(storeId, data.user.id, parsed.data.operationId));
      }
      if (operation === 'checkout') {
        if (!resolved.can('pos.use')) return json({ error: 'ไม่มีสิทธิ์ใช้งาน POS' }, 403);
        const parsed = checkoutSchema.safeParse(body);
        if (!parsed.success) return json({ error: 'ข้อมูลบิลไม่ถูกต้อง', notCreated: true }, 400);
        const existingId = await findNativeOrderId(ctx.organizationId, storeId, data.user.id, parsed.data.operationId);
        if (existingId) {
          const existing = await getOrder(existingId);
          if (existing.error || !existing.data || existing.data.storeId !== storeId || existing.data.organizationId !== ctx.organizationId) return json({ error: 'ตรวจสอบบิลเดิมไม่สำเร็จ', orderId: existingId }, 409);
          const complete = existing.data.status === 'paid';
          const closed = ['cancelled', 'voided', 'refunded'].includes(existing.data.status);
          return json({ error: complete || closed ? null : 'มีบิลเดิมแล้ว กรุณาจัดการบิลนี้ใน StoreOS ก่อนกดตรวจสอบอีกครั้ง', orderId: existingId, order: orderDto(existing.data), failedStage: complete || closed ? null : 'payment', ...(complete ? { outcome: 'paid' } : closed ? { outcome: 'closed', closedStatus: existing.data.status } : {}) });
        }
        const products = await listProducts(storeId, { productIds: [...new Set(parsed.data.lines.map(line => line.productId))] });
        if (products.error) return json({ error: 'ตรวจสอบราคาสินค้าไม่สำเร็จ' }, 502);
        let cart: ReturnType<typeof authoritativeCart>;
        try { cart = authoritativeCart(storeId, parsed.data, products.data ?? []); }
        catch (error) { return json({ error: error instanceof Error ? error.message : 'รายการสินค้าไม่พร้อมขาย', notCreated: true }, 400); }
        if (satang(cart.total) !== parsed.data.expectedTotalSatang) return json({ error: 'ราคาสินค้าเปลี่ยน กรุณาโหลดรายการใหม่และตรวจยอดก่อนรับเงิน', notCreated: true }, 409);
        if (parsed.data.method === 'cash' && parsed.data.receivedSatang < satang(cart.total)) return json({ error: 'เงินรับน้อยกว่ายอดบิล', notCreated: true }, 400);
        const operationKey = nativeOperationKey(data.user.id, storeId, parsed.data.operationId);
        const result = await withNativeRequestContext({ client, user: data.user, storeId, expectedTotalSatang: parsed.data.expectedTotalSatang }, () => checkoutAndPayAction(cart, { method: parsed.data.method, amount: cart.total, receivedAmount: parsed.data.method === 'cash' ? parsed.data.receivedSatang / 100 : undefined, changeAmount: parsed.data.method === 'cash' ? (parsed.data.receivedSatang - satang(cart.total)) / 100 : undefined }, { idempotencyKey: operationKey, paymentIdempotencyKey: operationKey }));
        return json({ ...result, order: result.order ? orderDto(result.order) : null });
      }
      if (operation === 'delivery-status') {
        if (!resolved.can('orders.manage_qr')) return json({ error: 'ไม่มีสิทธิ์จัดการเดลิเวอรี' }, 403);
        const parsed = z.object({ id: z.string().uuid(), next: z.enum(['accepted', 'preparing', 'ready', 'cancelled']) }).strict().safeParse(body);
        if (!parsed.success) return json({ error: 'สถานะไม่ถูกต้อง' }, 400);
        const order = await getConnectOrderById(ctx.organizationId, parsed.data.id);
        const link = order ? await getChannelLinkById(ctx.organizationId, order.linkId) : null;
        if (!order || !link || link.storeId !== storeId || link.channel !== 'jdc') return json({ error: 'ไม่พบออเดอร์ในร้านนี้' }, 404);
        if (!order.internalOrderId) return json({ error: 'ออเดอร์นี้ยังไม่มีรายละเอียดใน POS กรุณาตรวจผ่าน JDC' }, 409);
        const internal = await getOrder(order.internalOrderId);
        if (internal.error || !internal.data || internal.data.storeId !== storeId || internal.data.organizationId !== ctx.organizationId || !internal.data.items.length) return json({ error: 'ตรวจสอบรายละเอียดออเดอร์ในร้านนี้ไม่สำเร็จ' }, 409);
        const result = await applyPosStatus(link, order, parsed.data.next);
        return json(result, result.ok ? 200 : 409);
      }
      return json({ error: 'ไม่พบรายการที่เรียก' }, 404);
    } catch {
      return json({ error: 'ทำรายการไม่สำเร็จ กรุณาตรวจสิทธิ์และสถานะบิลก่อนลองใหม่' }, 400);
    }
  });
}
export const GET = handle;
export const POST = handle;
