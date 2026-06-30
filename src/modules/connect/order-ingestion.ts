// บริการรับออเดอร์จาก JDC → สร้าง order + order_items ใน StoreOS (Flow 2)
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { applyPosStatus } from "./status-sync";
import {
  getConnectOrder,
  insertConnectOrder,
  recordEvent,
  resolveProductIdByExternalRef,
  type ChannelLink,
} from "./repository";
import type { InboundOrderItem, InboundOrderPayload } from "./types";

/** cashier ปลอมระบบสำหรับออเดอร์ช่องทางภายนอก (orders.cashier_id not null, ไม่มี FK) */
const CONNECT_SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

export interface IngestResult {
  ok: boolean;
  duplicate?: boolean;
  connectOrderId?: string;
  error?: string;
}

function buildOrderNote(payload: InboundOrderPayload, unmapped: string[]): string {
  const parts = [`ออเดอร์เดลิเวอรี JDC #${payload.booking_id.slice(0, 8)}`];
  if (payload.customer && typeof payload.customer === "object") {
    const name = (payload.customer as Record<string, unknown>).name;
    if (typeof name === "string") parts.push(`ลูกค้า: ${name}`);
  }
  if (unmapped.length > 0) parts.push(`สินค้าที่ยังไม่ผูก: ${unmapped.join(", ")}`);
  return parts.join(" | ").slice(0, 500);
}

/**
 * idempotent ด้วย unique(link_id, external_order_id):
 * - ถ้าเคยรับแล้ว → duplicate
 * - map รายการผ่าน external_ref (= product.id) → สร้าง order(status=paid) + order_items
 * - บันทึก connect_orders (origin=jdc) แล้ว auto_accept ถ้าตั้งไว้
 */
export async function processInboundOrder(
  link: ChannelLink,
  payload: InboundOrderPayload,
): Promise<IngestResult> {
  const existing = await getConnectOrder(link.id, payload.booking_id);
  if (existing) {
    return { ok: true, duplicate: true, connectOrderId: existing.id };
  }

  const items: InboundOrderItem[] = payload.items ?? [];
  const mapped: { productId: string; name: string; qty: number; price: number }[] = [];
  const unmapped: string[] = [];
  for (const it of items) {
    const ref = it.external_ref ?? null;
    const productId = ref ? await resolveProductIdByExternalRef(link.storeId, ref) : null;
    if (productId) {
      mapped.push({ productId, name: it.name, qty: it.qty, price: it.price });
    } else {
      unmapped.push(it.name);
    }
  }

  const subtotal = mapped.reduce((s, m) => s + m.qty * m.price, 0);
  const total = typeof payload.total === "number" ? payload.total : subtotal;
  const now = new Date().toISOString();
  const supabase = await createSupabaseServiceClient();

  // สร้าง order ภายใน (ชำระโดย JDC → status=paid). ถ้าไม่มีรายการ map ได้เลย ข้ามการสร้าง order
  let internalOrderId: string | null = null;
  if (mapped.length > 0) {
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({
        organization_id: link.organizationId,
        store_id: link.storeId,
        order_number: `JDC-${payload.booking_id.slice(0, 8).toUpperCase()}`,
        status: "paid",
        cashier_id: CONNECT_SYSTEM_USER,
        subtotal,
        total,
        note: buildOrderNote(payload, unmapped),
        qr_order_source: false,
        paid_at: now,
      })
      .select("id")
      .single();
    if (orderErr || !order) {
      await recordEvent({
        linkId: link.id,
        direction: "inbound",
        topic: "order.created",
        payload,
        status: "failed",
        lastError: `create order failed: ${orderErr?.message ?? "unknown"}`,
      });
      return { ok: false, error: "สร้างออเดอร์ภายในไม่สำเร็จ" };
    }
    internalOrderId = order.id;

    const rows = mapped.map((m) => ({
      order_id: order.id,
      product_id: m.productId,
      product_name: m.name,
      quantity: m.qty,
      unit_price: m.price,
      total_price: m.qty * m.price,
    }));
    const { error: itemErr } = await supabase.from("order_items").insert(rows);
    if (itemErr) {
      await recordEvent({
        linkId: link.id,
        direction: "inbound",
        topic: "order.created",
        payload,
        status: "failed",
        lastError: `create order_items failed: ${itemErr.message}`,
      });
      return { ok: false, error: "สร้างรายการสินค้าไม่สำเร็จ" };
    }
  }

  const inserted = await insertConnectOrder({
    organizationId: link.organizationId,
    linkId: link.id,
    externalOrderId: payload.booking_id,
    internalOrderId,
    fulfillmentStatus: "received",
    lastStatusOrigin: "jdc",
    rawPayload: payload,
  });
  if (!inserted.ok) return { ok: false, error: inserted.error };

  await recordEvent({
    linkId: link.id,
    direction: "inbound",
    topic: "order.created",
    payload: { booking_id: payload.booking_id, mapped: mapped.length, unmapped: unmapped.length },
    status: "sent",
  });

  // auto-accept: รับออเดอร์ทันที + แจ้ง JDC ว่ากำลังเตรียม
  if (link.autoAccept) {
    await applyPosStatus(link, inserted.order, "accepted");
  }

  return { ok: true, connectOrderId: inserted.order.id };
}
