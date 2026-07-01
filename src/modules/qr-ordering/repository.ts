import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { SelectedModifier } from "@/modules/pos/types";
import type {
  QrOrderView,
  QrOrderLine,
  PrepStatus,
  ServiceRequest,
} from "./types";
import type { Database } from "@/server/integrations/supabase/database.types";

type OrderRow = Database["public"]["Tables"]["orders"]["Row"];
type OrderItemRow = Database["public"]["Tables"]["order_items"]["Row"];
type ServiceRequestRow = Database["public"]["Tables"]["service_requests"]["Row"];

function mapLine(row: OrderItemRow): QrOrderLine {
  return {
    id: row.id,
    productName: row.product_name,
    variantName: row.variant_name ?? undefined,
    kitchenStationId: row.kitchen_station_id ?? undefined,
    kitchenStationName: row.kitchen_station_name ?? undefined,
    modifiers: (row.modifiers as unknown as SelectedModifier[]) ?? [],
    quantity: row.quantity,
    unitPrice: row.unit_price,
    totalPrice: row.total_price,
    note: row.note ?? undefined,
    voided: row.voided,
    voidedReason: row.voided_reason ?? undefined,
  };
}

function mapOrder(row: OrderRow, items: QrOrderLine[]): QrOrderView {
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    prepStatus: row.prep_status,
    tableId: row.table_id ?? undefined,
    tableNumber: row.table_number ?? undefined,
    total: row.total,
    note: row.note ?? undefined,
    items,
    createdAt: row.created_at,
    paidAt: row.paid_at ?? undefined,
  };
}

function mapServiceRequest(row: ServiceRequestRow): ServiceRequest {
  return {
    id: row.id,
    storeId: row.store_id,
    tableId: row.table_id,
    tableNumber: row.table_number,
    type: row.type,
    status: row.status,
    note: row.note ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export function filterQrOrdersForStations(
  orders: QrOrderView[],
  stationIds: string[],
): QrOrderView[] {
  const allowedStationIds = new Set(stationIds);
  if (allowedStationIds.size === 0) return [];

  return orders
    .map((order) => {
      const items = order.items.filter((item) =>
        item.kitchenStationId ? allowedStationIds.has(item.kitchenStationId) : false,
      );
      return {
        ...order,
        items,
        total: items.reduce((sum, item) => sum + item.totalPrice, 0),
      };
    })
    .filter((order) => order.items.length > 0);
}

/** Fetch items for the given order ids, grouped by order id. */
async function fetchItemsByOrder(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  orderIds: string[],
): Promise<Map<string, QrOrderLine[]>> {
  const byOrder = new Map<string, QrOrderLine[]>();
  if (orderIds.length === 0) return byOrder;
  const { data } = await supabase
    .from("order_items")
    .select("*")
    .in("order_id", orderIds);
  for (const row of (data ?? []) as OrderItemRow[]) {
    const next = byOrder.get(row.order_id) ?? [];
    next.push(mapLine(row));
    byOrder.set(row.order_id, next);
  }
  return byOrder;
}

async function listQrOrders(
  storeId: string,
  statuses: OrderRow["status"][],
  opts: { ascending: boolean; limit?: number },
) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("orders")
    .select("*")
    .eq("store_id", storeId)
    .eq("qr_order_source", true)
    .in("status", statuses)
    .order("created_at", { ascending: opts.ascending });
  if (opts.limit) query = query.limit(opts.limit);

  const { data, error } = await query;
  if (error) return { data: null, error: mapError(error) };
  const rows = (data ?? []) as OrderRow[];
  const items = await fetchItemsByOrder(supabase, rows.map((r) => r.id));
  return { data: rows.map((r) => mapOrder(r, items.get(r.id) ?? [])), error: null };
}

/** Active (unpaid) QR orders for the restaurant board. */
export async function listActiveQrOrders(storeId: string) {
  return listQrOrders(storeId, ["open", "pending_payment"], { ascending: true });
}

/** Closed QR orders (history). */
export async function listQrOrderHistory(storeId: string, opts: { limit?: number } = {}) {
  return listQrOrders(storeId, ["paid", "voided", "cancelled", "refunded"], {
    ascending: false,
    limit: Math.min(opts.limit ?? 50, 200),
  });
}

export async function listPendingServiceRequests(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("service_requests")
    .select("*")
    .eq("store_id", storeId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapServiceRequest), error: null };
}

export async function updateOrderPrepStatus(
  orderId: string,
  storeId: string,
  prepStatus: PrepStatus,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("orders")
    .update({ prep_status: prepStatus, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .eq("store_id", storeId)
    .eq("qr_order_source", true);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

/** Kitchen voids one QR order line (e.g. out of stock) — restores stock + recomputes total. */
export async function voidQrOrderItem(
  storeId: string,
  orderId: string,
  itemId: string,
  reason: string | null,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("void_qr_order_item", {
    p_store_id: storeId,
    p_order_id: orderId,
    p_item_id: itemId,
    p_reason: reason,
  });
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function resolveServiceRequest(
  id: string,
  storeId: string,
  userId: string,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("service_requests")
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by_user_id: userId,
    })
    .eq("id", id)
    .eq("store_id", storeId)
    .eq("status", "pending");
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
