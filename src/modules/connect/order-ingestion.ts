// บริการรับออเดอร์จาก JDC → สร้าง order + order_items ใน StoreOS (Flow 2)
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { applyPosStatus } from "./status-sync";
import {
  applyDeliveryStockDelta,
  getConnectOrder,
  insertConnectOrder,
  recordEvent,
  resolveProductsForInbound,
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

/** ยอดที่ร้านต้องได้รับ = merchant_total ที่ JDC ส่งมา ไม่งั้นใช้ผลรวมราคาสินค้า */
function resolveMerchantTotal(payload: InboundOrderPayload, itemsSubtotal: number): number {
  return typeof payload.merchant_total === "number" ? payload.merchant_total : itemsSubtotal;
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

/** แปลงตัวเลือกยิบย่อยเป็น modifiers jsonb รูปแบบเดียวกับ QR (กันให้ตั๋วครัว/ใบเสร็จ render ได้) */
function toModifiers(options: InboundOrderItem["options"]): { option: { name: string; price: number } }[] {
  if (!options) return [];
  return options.map((o) => ({ option: { name: o.name, price: o.price ?? 0 } }));
}

/**
 * idempotent ด้วย unique(link_id, external_order_id):
 * - ถ้าเคยรับแล้ว → duplicate
 * - map รายการผ่าน external_ref (= product.id) → สร้าง order(status=open, ยังไม่ชำระ) + order_items
 *   (เก็บ kitchen_station + ตัวเลือกยิบย่อย) แล้ว auto_accept ถ้าตั้งไว้
 * - ออเดอร์จะขึ้น "ชำระแล้ว" ตอนคนขับกดรับอาหาร (ดู status-sync.applyInboundStatus)
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
  const resolved = await resolveProductsForInbound(
    link.storeId,
    items.map((it) => it.external_ref ?? "").filter(Boolean),
  );

  const mapped: {
    productId: string;
    name: string;
    qty: number;
    price: number;
    note: string | null;
    modifiers: { option: { name: string; price: number } }[];
    kitchenStationId: string | null;
    kitchenStationName: string | null;
  }[] = [];
  const unmapped: string[] = [];
  for (const it of items) {
    const r = it.external_ref ? resolved.get(it.external_ref) : undefined;
    if (r) {
      mapped.push({
        productId: r.productId,
        name: it.name,
        qty: it.qty,
        price: it.price,
        note: it.note ?? null,
        modifiers: toModifiers(it.options),
        kitchenStationId: r.kitchenStationId,
        kitchenStationName: r.kitchenStationName,
      });
    } else {
      unmapped.push(it.name);
    }
  }

  const itemsSubtotal = mapped.reduce((s, m) => s + m.qty * m.price, 0);
  const merchantTotal = resolveMerchantTotal(payload, itemsSubtotal);
  const now = new Date().toISOString();
  const supabase = await createSupabaseServiceClient();

  // สร้าง order ภายใน — status=open (ยังไม่ชำระ จนกว่าคนขับจะรับอาหาร)
  let internalOrderId: string | null = null;
  if (mapped.length > 0) {
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({
        organization_id: link.organizationId,
        store_id: link.storeId,
        order_number: `JDC-${payload.booking_id.slice(0, 8).toUpperCase()}`,
        status: "open",
        cashier_id: CONNECT_SYSTEM_USER,
        subtotal: merchantTotal,
        total: merchantTotal,
        note: buildOrderNote(payload, unmapped),
        qr_order_source: false,
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
      note: m.note,
      modifiers: m.modifiers as never,
      kitchen_station_id: m.kitchenStationId,
      kitchen_station_name: m.kitchenStationName,
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

    // ตัดสต็อก (best-effort — ไม่ให้กระทบการรับออเดอร์)
    try {
      await applyDeliveryStockDelta(
        mapped.map((m) => ({ productId: m.productId, qty: m.qty })),
        -1,
      );
    } catch {
      /* stock ผิดพลาดไม่บล็อกออเดอร์ */
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
