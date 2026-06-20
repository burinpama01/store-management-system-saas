import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import { generateOrderNumber } from "@/modules/pos/order-number";
import { getStoreLocalDate } from "@/modules/attendance/date";
import type { Cart } from "./types";
import type { Order, OrderItem, Payment } from "./types";
import type { Database, Json } from "@/server/integrations/supabase/database.types";

type OrderRow = Database["public"]["Tables"]["orders"]["Row"];
type OrderItemRow = Database["public"]["Tables"]["order_items"]["Row"];
type PaymentRow = Database["public"]["Tables"]["payments"]["Row"];
const HISTORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_POS_HISTORY_TIME_ZONE = "Asia/Bangkok";

function mapPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    orderId: row.order_id,
    method: row.method,
    amount: row.amount,
    status: row.status,
    reference: row.reference ?? undefined,
    receivedAmount: row.received_amount ?? undefined,
    changeAmount: row.change_amount ?? undefined,
    processedAt: row.processed_at,
    processedByUserId: row.processed_by_user_id,
  };
}

function mapOrderItem(row: OrderItemRow): OrderItem {
  return {
    id: row.id,
    orderId: row.order_id,
    productId: row.product_id,
    productName: row.product_name,
    variantId: row.variant_id ?? undefined,
    variantName: row.variant_name ?? undefined,
    modifiers: row.modifiers as unknown as OrderItem["modifiers"],
    quantity: row.quantity,
    unitPrice: row.unit_price,
    totalPrice: row.total_price,
    discount: row.discount_amount,
    discountType: row.discount_type ?? undefined,
    discountValue: row.discount_value ?? undefined,
    discountNote: row.discount_note ?? undefined,
    note: row.note ?? undefined,
  };
}

function mapOrder(row: OrderRow, items: OrderItem[], payments: Payment[]): Order {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    orderNumber: row.order_number,
    status: row.status,
    tableId: row.table_id ?? undefined,
    tableNumber: row.table_number ?? undefined,
    buffetSessionId: row.buffet_session_id ?? undefined,
    cashierId: row.cashier_id,
    items,
    subtotal: row.subtotal,
    discount: row.discount,
    discountNote: row.discount_note ?? undefined,
    total: row.total,
    payments,
    note: row.note ?? undefined,
    qrOrderSource: row.qr_order_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at ?? undefined,
    voidedAt: row.voided_at ?? undefined,
    voidReason: row.void_reason ?? undefined,
    voidedByUserId: row.voided_by_user_id ?? undefined,
  };
}

export interface CreateOrderInput {
  storeId: string;
  organizationId: string;
  cashierId: string;
  storeTimezone?: string;
  cart: Cart;
  tableId?: string;
  tableNumber?: string;
  note?: string;
}

export async function createOrderWithItems(input: CreateOrderInput) {
  const supabase = await createSupabaseServerClient();
  const orderNumber = generateOrderNumber({ timeZone: input.storeTimezone });
  const items = input.cart.items.map((item) => ({
    product_id: item.productId,
    product_name: item.productName,
    variant_id: item.variant?.id ?? null,
    variant_name: item.variant?.name ?? null,
    modifiers: item.modifiers,
    quantity: item.quantity,
    unit_price: item.unitPrice,
    total_price: item.totalPrice,
    discount_amount: item.discount ?? 0,
    discount_type: item.discountType ?? null,
    discount_value: item.discountValue ?? null,
    discount_note: item.discountNote ?? null,
    note: item.note ?? null,
  })) as unknown as Json;

  const { data: orderId, error: orderErr } = await supabase.rpc("create_pos_order_with_items", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_order_number: orderNumber,
    p_table_id: input.tableId ?? null,
    p_table_number: input.tableNumber ?? null,
    p_cashier_id: input.cashierId,
    p_subtotal: input.cart.subtotal,
    p_discount: input.cart.discount,
    p_discount_note: input.cart.discountNote ?? null,
    p_total: input.cart.total,
    p_note: input.note ?? null,
    p_items: items,
  });

  if (orderErr || !orderId) return { data: null, error: mapError(orderErr ?? new Error("ไม่สามารถสร้างออร์เดอร์ได้")) };

  return getOrder(orderId);
}

export interface AddPaymentInput {
  method: "cash" | "qr_promptpay" | "credit_card" | "bank_transfer" | "other";
  amount: number;
  receivedAmount?: number;
  changeAmount?: number;
  reference?: string;
  qrPaymentVerified?: boolean;
}

export interface ListOrdersHistoryOptions {
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

export async function addPaymentAndClose(orderId: string, storeId: string, processedByUserId: string, input: AddPaymentInput) {
  const supabase = await createSupabaseServerClient();
  const { data: paymentId, error: closeErr } = await supabase.rpc("close_pos_order_payment", {
    p_order_id: orderId,
    p_store_id: storeId,
    p_processed_by_user_id: processedByUserId,
    p_method: input.method,
    p_amount: input.amount,
    p_received_amount: input.receivedAmount ?? null,
    p_change_amount: input.changeAmount ?? null,
    p_reference: input.reference ?? null,
  });
  if (closeErr || !paymentId) return { data: null, error: mapError(closeErr ?? new Error("ออร์เดอร์นี้ไม่สามารถชำระได้")) };

  const { data: payment, error: payErr } = await supabase
    .from("payments")
    .select("*")
    .eq("id", paymentId)
    .single();
  if (payErr) return { data: null, error: mapError(payErr) };

  return { data: mapPayment(payment), error: null };
}

export async function voidOrder(orderId: string, storeId: string, userId: string, reason: string) {
  const supabase = await createSupabaseServerClient();
  // Atomically void — status whitelist prevents voiding already-paid or already-voided orders
  const { data, error } = await supabase
    .from("orders")
    .update({
      status: "voided",
      voided_at: new Date().toISOString(),
      void_reason: reason,
      voided_by_user_id: userId,
    })
    .eq("id", orderId)
    .eq("store_id", storeId)
    .in("status", ["pending_payment", "open"])
    .select("id")
    .single();
  if (error || !data) return { ok: false, error: mapError(error ?? new Error("ไม่สามารถยกเลิกออร์เดอร์นี้ได้")) };
  return { ok: true, error: null };
}

export async function getOrder(orderId: string) {
  const supabase = await createSupabaseServerClient();

  const [orderRes, itemsRes, paymentsRes] = await Promise.all([
    supabase.from("orders").select("*").eq("id", orderId).single(),
    supabase.from("order_items").select("*").eq("order_id", orderId),
    supabase.from("payments").select("*").eq("order_id", orderId),
  ]);

  if (orderRes.error) return { data: null, error: mapError(orderRes.error) };

  const items = (itemsRes.data ?? []).map(mapOrderItem);
  const payments = (paymentsRes.data ?? []).map(mapPayment);
  return { data: mapOrder(orderRes.data, items, payments), error: null };
}

function normalizedHistoryDate(value: string | undefined, fallback: string) {
  return value && HISTORY_DATE_PATTERN.test(value) ? value : fallback;
}

function safeHistoryTimeZone(timeZone: string | undefined) {
  const candidate = timeZone || DEFAULT_POS_HISTORY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_POS_HISTORY_TIME_ZONE;
  }
}

function parseHistoryDate(dateString: string) {
  const [year, month, day] = dateString.split("-").map(Number);
  return { year, month, day };
}

function addHistoryDateDays(dateString: string, days: number) {
  const { year, month, day } = parseHistoryDate(dateString);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getTimeZoneOffsetMs(timeZone: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const localAsUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return localAsUtc - date.getTime();
}

function localDateStartUtc(dateString: string, timeZone: string) {
  const { year, month, day } = parseHistoryDate(dateString);
  const localWallClockUtc = Date.UTC(year, month - 1, day);
  let utc = new Date(localWallClockUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getTimeZoneOffsetMs(timeZone, utc);
    const next = new Date(localWallClockUtc - offset);
    if (Math.abs(next.getTime() - utc.getTime()) < 1000) return next;
    utc = next;
  }
  return utc;
}

export function getStoreLocalDateRangeUtc(fromDateInput: string, toDateInput: string, storeTimezone = DEFAULT_POS_HISTORY_TIME_ZONE) {
  const timeZone = safeHistoryTimeZone(storeTimezone);
  const today = getStoreLocalDate(timeZone, new Date());
  const requestedFrom = normalizedHistoryDate(fromDateInput, today);
  const requestedTo = normalizedHistoryDate(toDateInput, requestedFrom);
  const fromDate = requestedFrom <= requestedTo ? requestedFrom : requestedTo;
  const toDate = requestedFrom <= requestedTo ? requestedTo : requestedFrom;
  const endDate = addHistoryDateDays(toDate, 1);
  return {
    startUtc: localDateStartUtc(fromDate, timeZone).toISOString(),
    endUtc: localDateStartUtc(endDate, timeZone).toISOString(),
  };
}

export async function listOrdersHistory(
  storeId: string,
  storeTimezone = "Asia/Bangkok",
  options: ListOrdersHistoryOptions = {},
) {
  const supabase = await createSupabaseServerClient();
  const now = new Date();
  const today = getStoreLocalDate(storeTimezone, now);
  const requestedFrom = normalizedHistoryDate(options.fromDate, today);
  const requestedTo = normalizedHistoryDate(options.toDate, requestedFrom);
  const fromDate = requestedFrom <= requestedTo ? requestedFrom : requestedTo;
  const toDate = requestedFrom <= requestedTo ? requestedTo : requestedFrom;
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 300), 1), 500);
  const { startUtc, endUtc } = getStoreLocalDateRangeUtc(fromDate, toDate, storeTimezone);

  const { data: orders, error } = await supabase
    .from("orders")
    .select("*")
    .eq("store_id", storeId)
    .gte("created_at", startUtc)
    .lt("created_at", endUtc)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return { data: null, error: mapError(error) };
  const historyOrders = orders ?? [];
  const orderIds = historyOrders.map((order) => order.id);
  if (orderIds.length === 0) return { data: [], error: null };

  const [itemsRes, paymentsRes] = await Promise.all([
    supabase.from("order_items").select("*").in("order_id", orderIds),
    supabase.from("payments").select("*").in("order_id", orderIds),
  ]);
  if (itemsRes.error) return { data: null, error: mapError(itemsRes.error) };
  if (paymentsRes.error) return { data: null, error: mapError(paymentsRes.error) };

  const itemsByOrder = new Map<string, OrderItem[]>();
  for (const item of itemsRes.data ?? []) {
    const mapped = mapOrderItem(item);
    const group = itemsByOrder.get(mapped.orderId) ?? [];
    group.push(mapped);
    itemsByOrder.set(mapped.orderId, group);
  }

  const paymentsByOrder = new Map<string, Payment[]>();
  for (const payment of paymentsRes.data ?? []) {
    const mapped = mapPayment(payment);
    const group = paymentsByOrder.get(mapped.orderId) ?? [];
    group.push(mapped);
    paymentsByOrder.set(mapped.orderId, group);
  }

  return {
    data: historyOrders.map((order) => mapOrder(order, itemsByOrder.get(order.id) ?? [], paymentsByOrder.get(order.id) ?? [])),
    error: null,
  };
}

export async function listTodayOrders(storeId: string, storeTimezone = "Asia/Bangkok") {
  const today = getStoreLocalDate(storeTimezone, new Date());
  return listOrdersHistory(storeId, storeTimezone, { fromDate: today, toDate: today, limit: 100 });
}
