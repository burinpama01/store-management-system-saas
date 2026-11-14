import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { openCashSessionAction, closeCashSessionAction } from '@/app/pos/cash-actions';
import { getOpenCashSession } from '@/modules/cashflow/repository';
import { getOrder, listOrdersHistory } from '@/modules/pos/order-repository';
import { listSavedTickets } from '@/modules/pos/saved-ticket-repository';
import { listProducts } from '@/modules/catalog/repository';
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/server/integrations/supabase/server';
import { authoritativeCart, satang } from './catalog';
import type { CashSession } from '@/modules/cashflow/types';
import type { Order, SavedOrderTicket, Cart } from '@/modules/pos/types';
import type { NativeLine, NativeOrder } from './contracts';
import type { NativeCashSession } from './workflow-contracts';

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const money = z.number().int().min(0).max(1000000000);
const note = z.string().max(200).optional();
const line = z.object({ key: z.string().max(1000), productId: id, name: z.string().max(500), quantity: z.number().int().min(1).max(999), unitSatang: money, variantId: id.nullable(), optionIds: z.array(id).max(50), note: z.string().max(500), choiceLabel: z.string().max(1000).optional() }).strict();
const saveSchema = z.object({ id: z.string().uuid(), label: z.string().trim().min(1).max(100), lines: z.array(line).min(1).max(100), expectedTotalSatang: money }).strict();
const resumeSchema = z.object({ id, updatedAt: z.string().datetime({ offset: true }), claimId: z.string().uuid() }).strict();
export interface WorkflowScope { storeId: string; organizationId: string; storeTimezone?: string; canRecord: boolean; userId?: string }
const response = (body: unknown, status = 200) => ({ body, status });
const failure = (error: string, status = 400) => response({ error }, status);
export const workflowOperations = new Set(['cash-session', 'cash-open', 'cash-close', 'tickets', 'ticket-save', 'ticket-resume', 'history', 'order-detail']);
export function nativeOrderDto(order: Order): NativeOrder {
  return { id: order.id, number: order.orderNumber, status: order.status, totalSatang: satang(order.total), createdAt: order.createdAt, lines: order.items.map(item => ({ key: item.id, productId: item.productId, name: item.productName, quantity: item.quantity, unitSatang: satang(item.unitPrice), variantId: item.variantId ?? null, optionIds: item.modifiers.map(m => m.option.id), note: item.note ?? '', choiceLabel: [item.variantName, ...item.modifiers.map(m => m.option.name), item.unitName].filter(Boolean).join(' · ') })) };
}
function cashDto(session: CashSession, expectedSatang: number | null): NativeCashSession {
  return { id: session.id, status: session.status, openingSatang: satang(session.openingFloat), expectedSatang, openedAt: session.openedAt, ...(session.closingCount !== undefined ? { closingSatang: satang(session.closingCount) } : {}), ...(session.variance !== undefined ? { varianceSatang: satang(session.variance) } : {}) };
}
// Existing cash preview helpers discard query errors. This path must fail closed.
async function cashStatus(scope: WorkflowScope) {
  const current = await getOpenCashSession(scope.storeId);
  if (current.error) return failure('โหลดรอบเงินสดไม่สำเร็จ', 502);
  if (!current.data) return response({ session: null, canRecord: scope.canRecord });
  if (current.data.storeId !== scope.storeId || current.data.organizationId !== scope.organizationId) return failure('รอบเงินสดไม่อยู่ในร้านนี้', 404);
  const client = await createSupabaseServerClient();
  const query = () => client.from('cash_ledger_entries').select('balance_after').eq('store_id', scope.storeId).order('created_at', { ascending: false }).limit(1);
  const [latest, atOpen] = await Promise.all([query().maybeSingle(), query().lt('created_at', current.data.openedAt).maybeSingle()]);
  if (latest.error || atOpen.error) return failure('ตรวจสอบเงินในลิ้นชักไม่สำเร็จ กรุณาโหลดใหม่', 502);
  const expected = satang(current.data.openingFloat + (latest.data?.balance_after ?? 0) - (atOpen.data?.balance_after ?? 0));
  if (!Number.isSafeInteger(expected)) return failure('ยอดเงินในลิ้นชักไม่ถูกต้อง', 502);
  return response({ session: cashDto(current.data, expected), canRecord: scope.canRecord });
}
function calendarDate(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : null;
}
function blockedReason(ticket: SavedOrderTicket): string | null {
  const cart = ticket.cart;
  if (ticket.tableId || ticket.tableNumber || ticket.buffetSessionId || ticket.customerName || ticket.note || ticket.ticketSource === 'table_auto') return 'บิลนี้มีข้อมูลโต๊ะ ลูกค้า หรือหมายเหตุ กรุณาเปิดผ่านเว็บ';
  if (cart.discount || cart.discountType || cart.discountValue || cart.discountNote || cart.items.some(item => item.unit || item.discount || item.discountType || item.discountValue || item.discountNote || item.rewardVoucherCode)) return 'บิลนี้มีหน่วยขาย ส่วนลด หรือรางวัล กรุณาเปิดผ่านเว็บ';
  if (!cart.items.length || cart.items.length > 100) return 'จำนวนรายการไม่รองรับ';
  return null;
}
function cartLines(cart: Cart): NativeLine[] { return cart.items.map(item => ({ key: item.key, productId: item.productId, name: item.productName, quantity: item.quantity, unitSatang: satang(item.unitPrice), variantId: item.variant?.id ?? null, optionIds: item.modifiers.map(m => m.option.id), note: item.note ?? '' })); }
function nativeSavedTicket(row: { id: string; label: string; cart_snapshot: unknown; created_at: string; updated_at: string }): SavedOrderTicket { return { id: row.id, label: row.label, ticketNumber: row.id, cart: row.cart_snapshot as Cart, createdAt: row.created_at, updatedAt: row.updated_at }; }
async function nativeTicketQuery(scope: WorkflowScope) { const service = await createSupabaseServiceClient() as unknown as SupabaseClient; return { service, scope }; }
async function canonicalCart(scope: WorkflowScope, lines: NativeLine[], expected: number) {
  const products = await listProducts(scope.storeId, { productIds: [...new Set(lines.map(item => item.productId))] });
  if (products.error) throw new Error('ตรวจสอบรายการสินค้าไม่สำเร็จ');
  const cart = authoritativeCart(scope.storeId, { operationId: '', lines, expectedTotalSatang: expected, method: 'cash', receivedSatang: 0 }, products.data ?? []);
  if (satang(cart.total) !== expected || lines.some((item, index) => satang(cart.items[index].unitPrice) !== item.unitSatang)) throw new Error('ราคาสินค้าเปลี่ยน กรุณาตรวจบิลผ่านเว็บก่อน');
  return cart;
}
// New RPCs are service-only: the verified HTTP actor and store are passed explicitly.
// Do not fall back to get/delete when the migration is unavailable.
async function ticketRpc(name: string, args: Record<string, unknown>) {
  const service = await createSupabaseServiceClient();
  const { data, error } = await (service.rpc as unknown as (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>)(name, args);
  if (error) return failure('ยังเปิดบิลพักไม่ได้ กรุณาตรวจสอบการติดตั้งระบบ แล้วตรวจสอบคำขอเดิมก่อนลองใหม่', 503);
  if (data && typeof data === 'object' && 'error' in data) return response(data, 409);
  return response(data);
}
export async function nativeWorkflow(operation: string, method: string, url: URL, body: unknown, scope: WorkflowScope): Promise<{ body: unknown; status: number } | null> {
  if (!workflowOperations.has(operation)) return null;
  if (method === 'GET' && operation === 'cash-session') return cashStatus(scope);
  if (method === 'POST' && (operation === 'cash-open' || operation === 'cash-close')) {
    if (!scope.canRecord) return failure('ไม่มีสิทธิ์บันทึกกระแสเงินสด', 403);
    if (operation === 'cash-open') {
      const parsed = z.object({ openingSatang: money, note }).strict().safeParse(body);
      if (!parsed.success) return failure('ยอดเงินเปิดร้านไม่ถูกต้อง');
      const result = await openCashSessionAction(parsed.data.openingSatang / 100, parsed.data.note);
      if (result.error) return failure(result.error, 409);
      return cashStatus(scope);
    }
    const parsed = z.object({ sessionId: id, closingSatang: money, note }).strict().safeParse(body);
    if (!parsed.success) return failure('ยอดเงินปิดรอบไม่ถูกต้อง');
    const result = await closeCashSessionAction(parsed.data.sessionId, parsed.data.closingSatang / 100, parsed.data.note);
    if (result.error || !result.session) return failure(result.error ?? 'ปิดรอบไม่สำเร็จ กรุณาตรวจสอบรอบเดิมก่อนลองใหม่', 409);
    if (result.session.storeId !== scope.storeId || result.session.organizationId !== scope.organizationId) return failure('รอบเงินสดไม่อยู่ในร้านนี้', 404);
    return response({ session: cashDto(result.session, result.session.expectedCash === undefined ? null : satang(result.session.expectedCash)) });
  }
  if (method === 'GET' && operation === 'history') {
    const fromDate = calendarDate(url.searchParams.get('fromDate')), toDate = calendarDate(url.searchParams.get('toDate'));
    if (!fromDate || !toDate || toDate < fromDate || (Date.parse(toDate) - Date.parse(fromDate)) / 86400000 > 30) return failure('เลือกช่วงวันที่จริง ไม่เกิน 31 วัน');
    const result = await listOrdersHistory(scope.storeId, scope.storeTimezone, { fromDate, toDate, limit: 100 });
    if (result.error) return failure('โหลดประวัติบิลไม่สำเร็จ', 502);
    if ((result.data ?? []).some(order => order.storeId !== scope.storeId || order.organizationId !== scope.organizationId)) return failure('ประวัติบิลไม่อยู่ในร้านนี้', 502);
    return response({ orders: (result.data ?? []).map(nativeOrderDto) });
  }
  if (method === 'GET' && operation === 'order-detail') {
    const parsed = id.safeParse(url.searchParams.get('id'));
    if (!parsed.success) return failure('รหัสบิลไม่ถูกต้อง');
    const result = await getOrder(parsed.data);
    if (result.error) return failure('โหลดรายละเอียดบิลไม่สำเร็จ', 502);
    if (!result.data || result.data.storeId !== scope.storeId || result.data.organizationId !== scope.organizationId) return failure('ไม่พบบิลในร้านนี้', 404);
    const order = result.data;
    return response({ order: { ...nativeOrderDto(order), subtotalSatang: satang(order.subtotal), discountSatang: satang(order.discount), note: order.note, payments: order.payments.map(payment => ({ method: payment.method, status: payment.status, amountSatang: satang(payment.amount), ...(payment.receivedAmount !== undefined ? { receivedSatang: satang(payment.receivedAmount) } : {}), ...(payment.changeAmount !== undefined ? { changeSatang: satang(payment.changeAmount) } : {}) })) } });
  }
  if (method === 'GET' && operation === 'tickets') {
    const { service } = await nativeTicketQuery(scope);
    const [native, web] = await Promise.all([service.from('native_pos_saved_tickets').select('*').eq('store_id', scope.storeId).eq('organization_id', scope.organizationId).order('updated_at', { ascending: false }).limit(30), listSavedTickets(scope.storeId)]);
    if (native.error || web.error) return failure('โหลดบิลพักไม่สำเร็จ กรุณาตรวจสอบการติดตั้งระบบ', 503);
    return response({ tickets: [...(native.data ?? []).map(row => { const ticket = nativeSavedTicket(row); const reason = blockedReason(ticket); return { id: ticket.id, label: ticket.label, updatedAt: ticket.updatedAt, totalSatang: satang(ticket.cart.total), lineCount: ticket.cart.items.length, resumable: !reason, ...(reason ? { blockedReason: reason } : {}) }; }), ...(web.data ?? []).map(ticket => ({ id: ticket.id, label: ticket.label, updatedAt: ticket.updatedAt, totalSatang: satang(ticket.cart.total), lineCount: ticket.cart.items.length, resumable: false, blockedReason: 'บิลนี้มีข้อมูลจากเว็บ กรุณาเปิดต่อบนเว็บ' }))] });
  }
  if (method === 'POST' && operation === 'ticket-save') {
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success || !scope.userId) return failure('ข้อมูลบิลพักไม่ถูกต้อง');
    // A committed save remains recoverable even if catalog prices subsequently change.
    const { service } = await nativeTicketQuery(scope);
    const prior = await service.from('native_pos_saved_tickets').select('*').eq('id', parsed.data.id).eq('store_id', scope.storeId).eq('organization_id', scope.organizationId).maybeSingle();
    if (prior.error) return failure('ตรวจสอบบิลพักเดิมไม่สำเร็จ', 503);
    if (prior.data) {
      const ticket = nativeSavedTicket(prior.data);
      const comparison = (lines: NativeLine[]) => JSON.stringify(lines.map(item => ({ productId: item.productId, variantId: item.variantId, optionIds: [...item.optionIds].sort(), quantity: item.quantity, note: item.note, unitSatang: item.unitSatang })));
      if (prior.data.created_by_user_id !== scope.userId || ticket.label !== parsed.data.label || satang(ticket.cart.total) !== parsed.data.expectedTotalSatang || comparison(cartLines(ticket.cart)) !== comparison(parsed.data.lines)) return failure('รหัสบิลพักมีข้อมูลเดิมแล้ว กรุณาตรวจบิลเดิม', 409);
      return response({ ticket: { id: ticket.id, label: ticket.label, updatedAt: ticket.updatedAt } });
    }
    let cart: Cart;
    try { cart = await canonicalCart(scope, parsed.data.lines, parsed.data.expectedTotalSatang); } catch (error) { return failure((error as Error).message, 409); }
    return ticketRpc('native_pos_save_ticket', { p_ticket_id: parsed.data.id, p_store_id: scope.storeId, p_organization_id: scope.organizationId, p_actor_id: scope.userId, p_label: parsed.data.label, p_cart: cart });
  }
  if (method === 'POST' && operation === 'ticket-resume') {
    const parsed = resumeSchema.safeParse(body);
    if (!parsed.success || !scope.userId) return failure('ข้อมูลเรียกบิลพักไม่ถูกต้อง');
    // Recovery must be checked before reading the deleted source ticket.
    const recovered = await ticketRpc('native_pos_ticket_result', { p_claim_id: parsed.data.claimId, p_ticket_id: parsed.data.id, p_store_id: scope.storeId, p_actor_id: scope.userId });
    if (recovered.status !== 200 || recovered.body) return recovered;
    const { service } = await nativeTicketQuery(scope);
    const result = await service.from('native_pos_saved_tickets').select('*').eq('id', parsed.data.id).eq('store_id', scope.storeId).eq('organization_id', scope.organizationId).maybeSingle();
    if (result.error) return failure('ตรวจสอบบิลพักไม่สำเร็จ', 502);
    const ticket = result.data ? nativeSavedTicket(result.data) : null;
    if (!ticket || ticket.cart.storeId !== scope.storeId) return failure('ไม่พบบิลพักในร้านนี้', 404);
    if (Date.parse(ticket.updatedAt) !== Date.parse(parsed.data.updatedAt)) return failure('บิลพักเปลี่ยนแล้ว กรุณาโหลดใหม่', 409);
    const reason = blockedReason(ticket);
    if (reason) return failure(reason, 409);
    const lines = cartLines(ticket.cart);
    if (!z.array(line).min(1).max(100).safeParse(lines).success) return failure('ข้อมูลบิลพักไม่รองรับ กรุณาตรวจผ่านเว็บ', 409);
    let cart: Cart;
    try { cart = await canonicalCart(scope, lines, satang(ticket.cart.total)); } catch (error) { return failure((error as Error).message, 409); }
    return ticketRpc('native_pos_claim_ticket', { p_claim_id: parsed.data.claimId, p_ticket_id: parsed.data.id, p_store_id: scope.storeId, p_organization_id: scope.organizationId, p_actor_id: scope.userId, p_updated_at: parsed.data.updatedAt, p_expected_cart: ticket.cart, p_result: { id: ticket.id, label: ticket.label, lines: cartLines(cart), checkoutOperationId: parsed.data.claimId } });
  }
  return failure('ไม่พบรายการที่เรียก', 404);
}
