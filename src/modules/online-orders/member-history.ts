import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { STATUS_LABEL, normalizeThaiPhone, type OnlineOrderStatus, type PricedLine } from "./core";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- online_orders ยังไม่อยู่ใน database.types
type LooseClient = any;

export interface MemberOrderSummary {
  id: string;
  orderCode: string;
  status: OnlineOrderStatus;
  statusLabel: string;
  fulfillment: "pickup" | "delivery";
  paymentMethod: "beam" | "cod";
  total: number;
  createdAt: string;
  publicToken: string;
  itemsText: string;
}

/**
 * ประวัติสั่งออนไลน์ของสมาชิก — ผูกด้วยเบอร์สมาชิก (ยืนยัน OTP แล้ว) + ร้านเดียวกันเท่านั้น
 * ผู้เรียกต้องได้ phone จาก session สมาชิกฝั่ง server (getMemberSessionByStoreId) ห้ามรับจาก client
 */
export async function listMemberOnlineOrders(storeId: string, memberPhone: string, limit = 30): Promise<MemberOrderSummary[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
  const phone = normalizeThaiPhone(memberPhone);
  if (!/^0[0-9]{8,9}$/.test(phone)) return [];
  const db: LooseClient = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("online_orders")
    .select("id, order_code, status, fulfillment, payment_method, total, created_at, public_token, items")
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .order("created_at", { ascending: false })
    .limit(safeLimit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const items = (Array.isArray(r.items) ? r.items : []) as PricedLine[];
    const status = r.status as OnlineOrderStatus;
    return {
      id: String(r.id),
      orderCode: String(r.order_code),
      status,
      statusLabel: STATUS_LABEL[status] ?? String(r.status),
      fulfillment: r.fulfillment === "pickup" ? "pickup" : "delivery",
      paymentMethod: r.payment_method === "cod" ? "cod" : "beam",
      total: Number(r.total ?? 0),
      createdAt: String(r.created_at),
      publicToken: String(r.public_token),
      itemsText: items.map((i) => `${i.quantity}× ${i.productName}`).join(", "),
    };
  });
}

/** รายการของออเดอร์เดิม (สำหรับสั่งอีกครั้ง) — ต้องเป็นร้านนี้และเบอร์ของสมาชิกคนนี้เท่านั้น */
export async function getMemberOrderLines(storeId: string, memberPhone: string, orderId: string): Promise<PricedLine[] | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return null;
  const phone = normalizeThaiPhone(memberPhone);
  if (!/^0[0-9]{8,9}$/.test(phone)) return null;
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("online_orders")
    .select("items")
    .eq("id", orderId)
    .eq("store_id", storeId)
    .eq("customer_phone", phone)
    .maybeSingle();
  if (!data || !Array.isArray(data.items)) return null;
  return data.items as PricedLine[];
}
