/**
 * Unified POS — Kitchen queue repository (Task U10, v0.37.1)
 *
 * แผนอ้างอิง: Plan/QR Order Voice Unified POS Implementation Plan v2.html
 *   - Task "U10 · Kitchen queue + Realtime fallback" (version 0.37.1)
 *
 * เส้นทางข้อมูลของคิวครัวใน unified shell:
 *   - อ่าน snapshot: query ผ่าน server client ปกติ (RLS ตาม session — เห็นเฉพาะร้านตัวเอง)
 *   - เปลี่ยนสถานะ: ยิง RPC unified_pos_update_item_fulfillment (U5) ผ่าน service client
 *     เหมือน convention ของ updateOrderPrepStatusGoverned (src/modules/qr-ordering/repository.ts)
 *     — actor ส่งชัดเจน และ RPC ตรวจ flag/สิทธิ์ (orders.manage_qr) + expected version เอง
 *
 * ข้อจำกัดจาก schema: order_items ไม่มีคอลัมน์ created_at — เรียงลำดับภายในออร์เดอร์ด้วย id
 */
import type { AppError } from "@/shared/utils/error";
import { mapError } from "@/shared/utils/error";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { FulfillmentStatus } from "./contracts";
import { FULFILLMENT_STATUSES, UNIFIED_POS_ERROR_CODES } from "./contracts";
import { computeRequestHash, createOperationKey, type UnifiedPosItemFulfillmentOutcome } from "./envelope";
import type { UnifiedKitchenItem } from "@/app/pos/unified/kitchen-types";

type OrderRow = Database["public"]["Tables"]["orders"]["Row"];
type OrderItemRow = Database["public"]["Tables"]["order_items"]["Row"];

/** สถานะออร์เดอร์ที่ยังอยู่ในคิว — ชุดเดียวกับ listActiveQrOrders (draft คือตะกร้า ยังไม่ส่งครัว) */
const ACTIVE_ORDER_STATUSES: OrderRow["status"][] = ["open", "pending_payment"];

/**
 * Snapshot คิวครัวของร้าน — ออเดอร์ที่ยังไม่ปิด (QR + พนักงาน) เรียงตามเวลาส่ง
 * (เก่าสุดก่อนตามธรรมชาติคิวครัว; item ภายในออร์เดอร์เรียงด้วย id เพื่อความ deterministic)
 */
export async function listUnifiedPosKitchenQueue(
  storeId: string,
): Promise<{ data: UnifiedKitchenItem[]; error: AppError | null }> {
  const supabase = await createSupabaseServerClient();

  const { data: orderRows, error: ordersError } = await supabase
    .from("orders")
    .select("id, order_number, table_number, qr_order_source, created_at")
    .eq("store_id", storeId)
    .in("status", ACTIVE_ORDER_STATUSES)
    .order("created_at", { ascending: true });
  if (ordersError) return { data: [], error: mapError(ordersError) };

  const orders = orderRows ?? [];
  if (orders.length === 0) return { data: [], error: null };

  const { data: itemRows, error: itemsError } = await supabase
    .from("order_items")
    .select(
      "id, order_id, product_name, variant_name, quantity, note, voided, voided_reason, fulfillment_status, fulfillment_version",
    )
    .in("order_id", orders.map((order) => order.id))
    .order("id", { ascending: true });
  if (itemsError) return { data: [], error: mapError(itemsError) };

  const contextByOrderId = new Map(orders.map((order) => [order.id, order]));
  const items: UnifiedKitchenItem[] = [];
  for (const row of (itemRows ?? []) as OrderItemRow[]) {
    const order = contextByOrderId.get(row.order_id);
    if (!order) continue; // กัน race ออร์เดอร์ถูกลบระหว่าง query สองชุด
    items.push({
      orderId: order.id,
      orderNumber: order.order_number,
      itemId: row.id,
      productName: row.product_name,
      variantName: row.variant_name ?? undefined,
      quantity: row.quantity,
      note: row.note ?? undefined,
      voided: row.voided,
      voidedReason: row.voided_reason ?? undefined,
      fulfillmentStatus: row.fulfillment_status,
      fulfillmentVersion: Number(row.fulfillment_version),
      source: order.qr_order_source ? "qr" : "staff",
      tableNumber: order.table_number ?? null,
      orderCreatedAt: order.created_at,
    });
  }
  return { data: items, error: null };
}

export interface UpdateKitchenItemFulfillmentInput {
  readonly organizationId: string;
  readonly storeId: string;
  readonly orderId: string;
  readonly itemId: string;
  readonly expectedFulfillmentVersion: number;
  readonly targetStatus: FulfillmentStatus;
  /** ผู้กดปุ่ม (จาก session ฝั่ง action) — RPC ตรวจสิทธิ์เองด้วย user_has_permission_in_store */
  readonly actorUserId: string;
}

export type UpdateKitchenItemFulfillmentResult =
  | { ok: true; fulfillmentStatus: FulfillmentStatus; fulfillmentVersion: number }
  | { ok: false; code: string; message: string };

/** bigint ผ่าน postgrest อาจมาเป็น number หรือ string — normalize เป็น number (กฎเดียวกับ realtime parser) */
function normalizeFulfillmentVersion(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
  }
  return null;
}

/**
 * เปลี่ยนสถานะ fulfillment ระดับ item หนึ่งรายการ ผ่าน governed RPC (U5)
 * คืนสถานะ/version ล่าสุดจาก server เสมอ (executed/replayed ใช้ result ของ receipt ได้เหมือนกัน)
 * — error code คงรูปจาก RPC (up_stale_version / up_invalid_state_transition / ...) เพื่อให้
 * client แยก conflict (refetch) ออกจาก error อื่นได้แบบ stable
 */
export async function updateKitchenItemFulfillment(
  input: UpdateKitchenItemFulfillmentInput,
): Promise<UpdateKitchenItemFulfillmentResult> {
  // defense-in-depth ฝั่ง repository — action ตรวจแล้วชั้นหนึ่ง
  if (!(FULFILLMENT_STATUSES as readonly string[]).includes(input.targetStatus)) {
    return {
      ok: false,
      code: UNIFIED_POS_ERROR_CODES.invalid_state_transition,
      message: "สถานะที่ต้องการไม่ถูกต้อง",
    };
  }
  if (!Number.isSafeInteger(input.expectedFulfillmentVersion) || input.expectedFulfillmentVersion < 1) {
    return {
      ok: false,
      code: UNIFIED_POS_ERROR_CODES.stale_version,
      message: "เวอร์ชันรายการไม่ถูกต้อง กรุณารีเฟรชหน้าจอ",
    };
  }

  // [U5 convention] RPC grant ให้ service_role เท่านั้น (20260901000003) — เรียกผ่าน service client
  const serviceClient = await createSupabaseServiceClient();
  const { data, error } = await serviceClient.rpc("unified_pos_update_item_fulfillment", {
    p_organization_id: input.organizationId,
    p_store_id: input.storeId,
    p_order_id: input.orderId,
    p_item_id: input.itemId,
    p_expected_fulfillment_version: input.expectedFulfillmentVersion,
    p_target_fulfillment_status: input.targetStatus,
    p_operation_key: createOperationKey(),
    p_request_hash: computeRequestHash({
      storeId: input.storeId,
      orderId: input.orderId,
      itemId: input.itemId,
      target: input.targetStatus,
      expectedVersion: input.expectedFulfillmentVersion,
    }),
    p_actor_user_id: input.actorUserId,
  });
  if (error) {
    const mapped = mapError(error);
    return { ok: false, code: mapped.code, message: mapped.userMessage };
  }

  const outcome = data as UnifiedPosItemFulfillmentOutcome | null;
  if (!outcome) {
    return { ok: false, code: "up_unexpected", message: "เปลี่ยนสถานะไม่สำเร็จ กรุณาลองใหม่" };
  }
  if (outcome.status === "hash_conflict") {
    return {
      ok: false,
      code: UNIFIED_POS_ERROR_CODES.hash_conflict,
      message: "คำขอซ้ำแต่เนื้อหาไม่ตรงกัน — กรุณารีเฟรชหน้าจอ",
    };
  }
  if (outcome.status === "error") {
    return { ok: false, code: outcome.code, message: outcome.message };
  }

  // executed/replayed — result ของ receipt คือความจริงล่าสุดจาก server (replayed ก็ค่าเดียวกัน)
  const result = outcome.result;
  const version = normalizeFulfillmentVersion(result?.fulfillment_version);
  const status = result?.fulfillment_status;
  if (version === null || !status || !(FULFILLMENT_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, code: "up_unexpected", message: "ผลลัพธ์จากระบบไม่ครบถ้วน กรุณารีเฟรชหน้าจอ" };
  }
  return { ok: true, fulfillmentStatus: status as FulfillmentStatus, fulfillmentVersion: version };
}
