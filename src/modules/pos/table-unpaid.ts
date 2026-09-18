import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/integrations/supabase/database.types";

/**
 * บิลค้างของโต๊ะ = ขอบเขตของ "รอบโต๊ะ": 1 โต๊ะ = 1 บิล ต้องไม่มีรายการของลูกค้ารอบก่อนปนกับรอบใหม่
 * - ปิดโต๊ะ / เปิดโต๊ะใหม่ / ลูกค้าเปิดโต๊ะเอง → ต้องไม่มีบิลค้าง (เช็คบิลก่อน)
 * - อ่านไม่ได้ = ถือว่ามี (fail closed) — ยืนยันไม่ได้ว่าว่างห้ามปล่อยผ่าน
 */
export type TableUnpaidContext =
  | { ok: true; openOrders: number; nonEmptyTickets: number; hasUnpaid: boolean }
  | { ok: false; error: string };

export async function findTableUnpaidContext(
  supabase: SupabaseClient<Database>,
  storeId: string,
  tableId: string,
  opts?: { excludeTicketId?: string },
): Promise<TableUnpaidContext> {
  const [ordersRes, ticketsRes] = await Promise.all([
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("table_id", tableId)
      .in("status", ["open", "pending_payment"]),
    supabase
      .from("pos_saved_tickets")
      .select("id, cart_snapshot")
      .eq("store_id", storeId)
      .eq("table_id", tableId),
  ]);
  if (ordersRes.error || ticketsRes.error) {
    return { ok: false, error: "ตรวจบิลค้างของโต๊ะไม่สำเร็จ ลองใหม่อีกครั้ง" };
  }
  const nonEmptyTickets = (ticketsRes.data ?? []).filter((ticket) => {
    if (opts?.excludeTicketId && ticket.id === opts.excludeTicketId) return false;
    const items = (ticket.cart_snapshot as { items?: unknown } | null)?.items;
    return Array.isArray(items) && items.length > 0;
  }).length;
  const openOrders = ordersRes.count ?? 0;
  return { ok: true, openOrders, nonEmptyTickets, hasUnpaid: openOrders > 0 || nonEmptyTickets > 0 };
}

export function describeTableUnpaid(ctx: { openOrders: number; nonEmptyTickets: number }): string {
  const parts = [
    ctx.openOrders > 0 ? `ออเดอร์ค้าง ${ctx.openOrders} ใบ` : null,
    ctx.nonEmptyTickets > 0 ? `ตั๋วที่มีรายการ ${ctx.nonEmptyTickets} ใบ` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}
