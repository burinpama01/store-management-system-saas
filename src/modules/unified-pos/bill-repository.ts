/**
 * Unified POS — Table bill repository (Task U11, v0.37.2)
 *
 * แผนอ้างอิง: Plan/QR Order Voice Unified POS Implementation Plan v2.html
 *   - Task "U11 · Bill tools + print replay contract" (version 0.37.2)
 *
 * บิลของแท็บบิลใน unified shell — อ่านจาก DB ฝั่ง server เท่านั้น (convention
 * เดียวกับ listUnifiedPosKitchenQueue: createSupabaseServerClient + RLS + scope
 * ตามร้าน):
 *   - ออเดอร์ที่ยังชำระ = status ∈ (open, pending_payment) + paid_at IS NULL
 *     (ชุดเดียวกับที่ RPC settlement อนุญาต/คิดเงิน — U7)
 *   - รายการในบิล = order_items ที่ voided=false เท่านั้น (canonical void U1 —
 *     รายการที่ reject ไปแล้วไม่ใช่หนี้ลูกค้า)
 *   - ยอดต่อบิล = orders.total (ไม่เคยคำนวณจากฝั่ง client)
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  UnifiedPosBillItemView,
  UnifiedPosBillOrderView,
  UnifiedPosBillPaymentView,
  UnifiedPosTableBillView,
} from "@/app/pos/unified/bill-types";

type OrderRow = Database["public"]["Tables"]["orders"]["Row"];
type OrderItemRow = Database["public"]["Tables"]["order_items"]["Row"];
type PaymentRow = Database["public"]["Tables"]["payments"]["Row"];

/**
 * ออเดอร์ที่แท็บบิลแสดง — status = 'open' เท่านั้น เพื่อให้ "ยอดรวมทั้งโต๊ะ" ตรงกับ
 * ชุดที่ RPC settlement โหมด whole_table จะชำระจริง (U7 กรอง open เท่านั้น —
 * pending_payment เป็นสถานะ legacy ที่ RPC รับใน partial แต่ whole_table ไม่ครอบ
 * จึงไม่นับในบิลทั้งโต๊ะ ไม่งั้นยอดบนจอกับยอดที่ตัดเงินไม่เท่ากัน)
 */
const SETTLEABLE_ORDER_STATUSES: OrderRow["status"][] = ["open"];

/** ดึงชื่อ modifier จาก modifiers jsonb แบบ defensively (รับทั้ง wrapper option และ direct) */
export function parseModifierNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const option = (entry as { option?: { name?: unknown } | null }).option;
    const name = option && typeof option.name === "string" ? option.name : (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names;
}

/** แปลงแถว order_items (server row) → view รายการในบิล (คัดเฉพาะรายการที่ยัง active) */
export function mapBillOrderItem(item: OrderItemRow): UnifiedPosBillItemView | null {
  if (item.voided) return null; // canonical: บิลไม่นับรายการ voided
  return {
    itemId: item.id,
    productName: item.product_name,
    variantName: item.variant_name ?? undefined,
    modifierNames: parseModifierNames(item.modifiers),
    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    totalPrice: Number(item.total_price),
    note: item.note ?? undefined,
  };
}

/**
 * บิลทั้งโต๊ะ (server truth): ออเดอร์ที่ยังชำระ + รายการ active + การชำระที่มีอยู่
 * ยอดรวม = orders.total (คอลัมน์ที่ RPC settlement ใช้) — ไม่มีบิล → คืน view ว่าง
 * client พารามิเตอร์ที่ 3 เป็น test seam เท่านั้น — production ใช้ user client (RLS) เสมอ
 */
export async function fetchTableBillForTable(
  storeId: string,
  tableId: string,
  client?: SupabaseClient<Database>,
): Promise<UnifiedPosTableBillView> {
  const supabase = client ?? (await createSupabaseServerClient());

  const { data: orderRows } = await supabase
    .from("orders")
    .select("id, order_number, status, prep_status, revision, subtotal, discount, total, table_id, table_number, qr_order_source, paid_at")
    .eq("store_id", storeId)
    .eq("table_id", tableId)
    .in("status", SETTLEABLE_ORDER_STATUSES)
    .is("paid_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  const orders = (orderRows ?? []) as Array<
    Pick<
      OrderRow,
      | "id"
      | "order_number"
      | "status"
      | "revision"
      | "subtotal"
      | "discount"
      | "total"
      | "table_id"
      | "table_number"
      | "qr_order_source"
    >
  >;
  if (orders.length === 0) {
    return {
      tableId,
      tableNumber: null,
      orders: [],
      grandTotal: 0,
      fetchedAt: new Date().toISOString(),
    };
  }

  const orderIds = orders.map((o) => o.id);
  const [{ data: itemRows }, { data: paymentRows }] = await Promise.all([
    supabase
      .from("order_items")
      .select("id, order_id, product_name, variant_name, modifiers, quantity, unit_price, total_price, note, voided")
      .in("order_id", orderIds)
      .order("id", { ascending: true }),
    supabase
      .from("payments")
      .select("id, order_id, method, amount, status, processed_at")
      .in("order_id", orderIds)
      .in("status", ["completed"]),
  ]);

  const itemsByOrder = new Map<string, UnifiedPosBillItemView[]>();
  for (const row of (itemRows ?? []) as OrderItemRow[]) {
    const view = mapBillOrderItem(row);
    if (!view) continue;
    const list = itemsByOrder.get(row.order_id) ?? [];
    list.push(view);
    itemsByOrder.set(row.order_id, list);
  }
  const paymentsByOrder = new Map<string, UnifiedPosBillPaymentView[]>();
  for (const row of (paymentRows ?? []) as PaymentRow[]) {
    const list = paymentsByOrder.get(row.order_id) ?? [];
    list.push({
      paymentId: row.id,
      method: row.method,
      amount: Number(row.amount),
      processedAt: row.processed_at ?? undefined,
    });
    paymentsByOrder.set(row.order_id, list);
  }

  const viewOrders: UnifiedPosBillOrderView[] = orders.map((order) => {
    const items = itemsByOrder.get(order.id) ?? [];
    const itemsSubtotal = Math.round(items.reduce((sum, item) => sum + item.totalPrice, 0) * 100) / 100;
    return {
      orderId: order.id,
      orderNumber: order.order_number,
      source: order.qr_order_source ? "qr" : "staff",
      status: order.status,
      revision: order.revision,
      itemsSubtotal,
      discount: Number(order.discount),
      total: Number(order.total),
      items,
      payments: paymentsByOrder.get(order.id) ?? [],
    };
  });

  const grandTotal = Math.round(viewOrders.reduce((sum, order) => sum + order.total, 0) * 100) / 100;
  return {
    tableId,
    tableNumber: orders[0]?.table_number ?? null,
    orders: viewOrders,
    grandTotal,
    fetchedAt: new Date().toISOString(),
  };
}
