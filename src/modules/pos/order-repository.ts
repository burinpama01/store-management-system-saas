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

export async function listTodayOrders(storeId: string, storeTimezone = "Asia/Bangkok") {
  const supabase = await createSupabaseServerClient();
  const now = new Date();
  const storeToday = getStoreLocalDate(storeTimezone, now);
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - 1);
  windowStart.setUTCHours(0, 0, 0, 0);
  const windowEnd = new Date(now);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
  windowEnd.setUTCHours(23, 59, 59, 999);

  const { data: orders, error } = await supabase
    .from("orders")
    .select("*")
    .eq("store_id", storeId)
    .gte("created_at", windowStart.toISOString())
    .lte("created_at", windowEnd.toISOString())
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) return { data: null, error: mapError(error) };
  const todayOrders = (orders ?? [])
    .filter((order) => getStoreLocalDate(storeTimezone, new Date(order.created_at)) === storeToday)
    .slice(0, 100);
  const orderIds = todayOrders.map((order) => order.id);
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
    data: todayOrders.map((order) => mapOrder(order, itemsByOrder.get(order.id) ?? [], paymentsByOrder.get(order.id) ?? [])),
    error: null,
  };
}
