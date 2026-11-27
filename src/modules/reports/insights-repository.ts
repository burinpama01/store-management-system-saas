/**
 * โหลดรายงานเชิงลึกผ่าน RPC get_sales_insights (security invoker — ใช้ RLS ของผู้ใช้)
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { logSystemEvent } from "@/modules/system/event-log";
import { parseInsights, type InsightsRaw } from "./insights";

export async function getSalesInsights(
  scope: { organizationId: string; storeId: string; userId?: string },
  dateFrom: string,
  dateTo: string,
): Promise<{ data: InsightsRaw | null; error: string | null }> {
  const supabase = await createSupabaseServerClient();
  const startedAt = Date.now();
  const { data, error } = await supabase.rpc("get_sales_insights", {
    p_store_id: scope.storeId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });
  const durationMs = Date.now() - startedAt;

  if (error) {
    await logSystemEvent({
      level: "error",
      source: "reports.insights",
      action: "getSalesInsights",
      message: `โหลดรายงานเชิงลึกไม่สำเร็จ: ${error.message}`,
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      actorUserId: scope.userId,
      errorCode: error.code,
      durationMs,
      context: { dateFrom, dateTo },
    }).catch(() => undefined);
    // 22023 = ข้อความภาษาไทยที่ RPC ตั้งใจให้ผู้ใช้อ่าน (ช่วงวันที่ผิด)
    return { data: null, error: error.code === "22023" ? error.message : "โหลดรายงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" };
  }

  const parsed = parseInsights(data);
  // เส้นทางสำเร็จ: เก็บเฉพาะตัวเลขสรุป/เวลา ไม่เก็บชื่อเมนูหรือยอดรายเมนู
  await logSystemEvent({
    level: durationMs > 5000 ? "warn" : "info",
    source: "reports.insights",
    action: "getSalesInsights",
    message: durationMs > 5000 ? "รายงานเชิงลึกโหลดช้า" : "โหลดรายงานเชิงลึก",
    organizationId: scope.organizationId,
    storeId: scope.storeId,
    actorUserId: scope.userId,
    durationMs,
    context: { dateFrom, dateTo, days: parsed.range.days, orders: parsed.summary.orders, products: parsed.products.length },
  }).catch(() => undefined);
  return { data: parsed, error: null };
}
