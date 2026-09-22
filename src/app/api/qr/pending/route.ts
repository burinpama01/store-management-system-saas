// ออเดอร์ QR ใหม่ที่ครัวยังไม่รับ (สำหรับ dialog แจ้งเตือน) — ทางสำรองแบบ polling คู่กับ realtime
// เหมือน /api/connect/pending: บางจอ (เช่น POS) realtime ของ orders ไม่ส่งเหตุการณ์มา dialog เลยไม่เด้ง
// ใช้ service client แต่กรองขอบเขตสถานีครัวฝั่งเซิร์ฟเวอร์เอง (ไม่เชื่อค่าจาก client)
import { getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { resolveKitchenStationScope } from "@/modules/qr-ordering/kitchen-stations";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export const dynamic = "force-dynamic";

/** ย้อนดูแค่ช่วงสั้น ๆ — ออเดอร์ที่ค้างนานกว่านี้ดูที่หน้า QR Order ไม่ต้องเด้ง */
const LOOKBACK_MS = 30 * 60 * 1000;

const ITEM_COLUMNS =
  "id, order_id, product_name, variant_name, kitchen_station_id, kitchen_station_name, modifiers, quantity, unit_price, total_price, note";

export async function GET(): Promise<Response> {
  const authz = await getOptionalResolvedCurrentPermissions();
  if (!authz) return Response.json({ orders: [] }, { status: 401 });
  const { user, ctx, resolved } = authz;
  if (!resolved.can("orders.manage_qr")) return Response.json({ orders: [] }, { status: 403 });

  const scope = await resolveKitchenStationScope(ctx.storeId, user.id, ctx.role);
  if (!scope.canSeeAll && scope.stationIds.length === 0) return Response.json({ orders: [] });

  const supabase = await createSupabaseServiceClient();
  const { data: orderRows } = await supabase
    .from("orders")
    .select("id, order_number, table_number, created_at")
    .eq("store_id", ctx.storeId)
    .eq("qr_order_source", true)
    // บิลรวมโต๊ะเป็นรายการที่ครัวทำไปแล้ว ห้ามเด้งซ้ำ (เงื่อนไขเดียวกับฝั่ง realtime)
    .is("table_bill_key", null)
    .eq("prep_status", "new")
    .in("status", ["open", "pending_payment"])
    .gte("created_at", new Date(Date.now() - LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(20);
  if (!orderRows || orderRows.length === 0) return Response.json({ orders: [] });

  let itemQuery = supabase
    .from("order_items")
    .select(ITEM_COLUMNS)
    .in(
      "order_id",
      orderRows.map((row) => row.id),
    );
  if (!scope.canSeeAll) itemQuery = itemQuery.in("kitchen_station_id", scope.stationIds);
  const { data: itemRows } = await itemQuery;

  const itemsByOrder = new Map<string, NonNullable<typeof itemRows>>();
  for (const item of itemRows ?? []) {
    const list = itemsByOrder.get(item.order_id) ?? [];
    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  const orders = orderRows
    .map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      tableNumber: row.table_number,
      createdAt: row.created_at,
      items: itemsByOrder.get(row.id) ?? [],
    }))
    // จอที่ผูกสถานี: ออเดอร์ที่ไม่มีรายการของสถานีตัวเองไม่ต้องเด้ง
    .filter((order) => scope.canSeeAll || order.items.length > 0);

  return Response.json({ orders });
}
