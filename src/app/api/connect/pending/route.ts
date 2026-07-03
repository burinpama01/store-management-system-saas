// ออเดอร์เดลิเวอรีที่รอรับ (สำหรับ popup แจ้งเตือน) — ใช้ service client เลี่ยงปัญหา RLS
// (orders RLS: staff อ่าน qr_order_source=false ไม่ได้ → realtime ไม่ส่ง; polling นี้ครอบทุก role)
import { getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getActiveLinkByStore } from "@/modules/connect/repository";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

export const dynamic = "force-dynamic";

interface RawItem {
  name?: string;
  qty?: number;
  options?: { name?: string }[];
  note?: string | null;
}

export async function GET(): Promise<Response> {
  const authz = await getOptionalResolvedCurrentPermissions();
  if (!authz) return Response.json({ orders: [] }, { status: 401 });
  const { ctx, resolved } = authz;
  if (!resolved.can("orders.manage_qr")) return Response.json({ orders: [] }, { status: 403 });

  const link = await getActiveLinkByStore(ctx.storeId);
  if (!link) return Response.json({ orders: [] });

  const supabase = await createSupabaseServiceClient();
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("connect_orders")
    .select("id, external_order_id, internal_order_id, fulfillment_status, raw_payload, orders(order_number, total)")
    .eq("link_id", link.id)
    .eq("fulfillment_status", "received")
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(20);

  const orders = (data ?? []).map((r) => {
    const rec = r as unknown as {
      id: string;
      external_order_id: string;
      internal_order_id: string | null;
      raw_payload: { items?: RawItem[] } | null;
      orders: { order_number: string; total: number } | null;
    };
    const items = (rec.raw_payload?.items ?? []).map((it) => ({
      name: it.name ?? "",
      quantity: it.qty ?? 1,
      optionNames: (it.options ?? []).map((o) => o.name ?? "").filter(Boolean),
      note: it.note ?? null,
    }));
    return {
      id: rec.id,
      internalOrderId: rec.internal_order_id,
      billNumber: rec.orders?.order_number ?? `JDC-${rec.external_order_id.slice(0, 8).toUpperCase()}`,
      shopAmount: rec.orders?.total ?? 0,
      items,
    };
  });

  return Response.json({ orders });
}
