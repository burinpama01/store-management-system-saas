import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { SelectedModifier } from "@/modules/pos/types";
import type {
  QrOrderView,
  QrOrderLine,
  PrepStatus,
  ServiceRequest,
} from "./types";
import { UNIFIED_POS_ERROR_CODES } from "@/modules/unified-pos/contracts";
import { planOrderPrepAdvance } from "@/modules/unified-pos/prep-advance";
import {
  computeRequestHash,
  createOperationKey,
  type UnifiedPosItemFulfillmentOutcome,
} from "@/modules/unified-pos/envelope";
import type { AppError } from "@/shared/utils/error";
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

function appError(code: string, message: string): AppError {
  return { code, message, userMessage: message };
}

/**
 * U5 (v0.35.5): เส้นทาง governed — แปลงปุ่มระดับ order (legacy) ให้เป็น item-level
 * moves ผ่าน unified_pos_update_item_fulfillment (หนึ่ง RPC ต่อหนึ่ง move)
 * - ร้านที่เปิด unified_pos_enabled เท่านั้น (ตรวจใน updateOrderPrepStatus)
 * - target 'done'/'new' ถูกปฏิเสธโดย planOrderPrepAdvance
 * - item ที่ actor อื่นขยับก่อน (stale/transition ไม่ผ่าน) ถูกข้าม — ลำดับที่เหลือไปต่อ
 */
async function updateOrderPrepStatusGoverned(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  input: {
    orderId: string;
    storeId: string;
    organizationId: string;
    prepStatus: PrepStatus;
    actorUserId?: string;
  },
): Promise<{ ok: boolean; error: AppError | null }> {
  const { orderId, storeId, organizationId, prepStatus, actorUserId } = input;
  if (!actorUserId) {
    return { ok: false, error: appError(UNIFIED_POS_ERROR_CODES.forbidden, "ไม่มีสิทธิ์เปลี่ยนสถานะรายการ") };
  }

  // scope เดียวกับ legacy: order ที่สั่งผ่าน QR ในร้านนี้
  const { data: order } = await supabase
    .from("orders")
    .select("id")
    .eq("id", orderId)
    .eq("store_id", storeId)
    .eq("qr_order_source", true)
    .maybeSingle();
  if (!order) return { ok: false, error: appError(UNIFIED_POS_ERROR_CODES.not_found, "ไม่พบออเดอร์") };

  const { data: itemRows, error: itemsErr } = await supabase
    .from("order_items")
    .select("id, voided, fulfillment_status, fulfillment_version")
    .eq("order_id", orderId);
  if (itemsErr) return { ok: false, error: mapError(itemsErr) };

  const plan = planOrderPrepAdvance(
    (itemRows ?? []).map((row) => ({
      id: row.id,
      voided: row.voided,
      fulfillmentStatus: row.fulfillment_status,
    })),
    prepStatus,
  );
  if (plan.kind === "rejected") {
    return { ok: false, error: appError(plan.code, plan.message) };
  }
  if (plan.kind === "noop") return { ok: true, error: null };

  const versionByItem = new Map(
    (itemRows ?? []).map((row) => [row.id, row.fulfillment_version] as const),
  );

  for (const move of plan.moves) {
    const expectedVersion = versionByItem.get(move.itemId);
    if (expectedVersion === undefined) continue;

    const { data, error } = await supabase.rpc("unified_pos_update_item_fulfillment", {
      p_organization_id: organizationId,
      p_store_id: storeId,
      p_order_id: orderId,
      p_item_id: move.itemId,
      p_expected_fulfillment_version: expectedVersion,
      p_target_fulfillment_status: move.to,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({
        storeId,
        orderId,
        itemId: move.itemId,
        target: move.to,
        expectedVersion,
      }),
      p_actor_user_id: actorUserId,
    });
    if (error) return { ok: false, error: mapError(error) };

    const outcome = data as UnifiedPosItemFulfillmentOutcome | null;
    if (!outcome) {
      return { ok: false, error: appError("up_unexpected", "เปลี่ยนสถานะไม่สำเร็จ กรุณาลองใหม่") };
    }
    if (outcome.status === "error") {
      // actor อื่นขยับ item นี้ไปก่อน → ข้าม แล้วดำเนินการ item ที่เหลือ
      if (
        outcome.code === UNIFIED_POS_ERROR_CODES.stale_version ||
        outcome.code === UNIFIED_POS_ERROR_CODES.invalid_state_transition
      ) {
        continue;
      }
      return { ok: false, error: appError(outcome.code, outcome.message) };
    }
  }

  return { ok: true, error: null };
}

/**
 * เปลี่ยนสถานะเตรียมอาหารระดับ order (kitchen board)
 * - ร้านที่เปิด unified_pos_enabled → route ผ่าน governed item fulfillment (U5)
 * - ร้านที่ปิด flag → เขียนตรง orders.prep_status ตามพฤติกรรม legacy เดิมทุกอย่าง
 */
export async function updateOrderPrepStatus(
  orderId: string,
  storeId: string,
  prepStatus: PrepStatus,
  actorUserId?: string,
) {
  const supabase = await createSupabaseServerClient();

  const { data: store } = await supabase
    .from("stores")
    .select("organization_id, unified_pos_enabled")
    .eq("id", storeId)
    .maybeSingle();
  if (store?.unified_pos_enabled) {
    return updateOrderPrepStatusGoverned(supabase, {
      orderId,
      storeId,
      organizationId: store.organization_id,
      prepStatus,
      actorUserId,
    });
  }

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
