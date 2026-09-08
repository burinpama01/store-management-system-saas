"use server";

/**
 * ส่งออก CSV ทำฝั่งเบราว์เซอร์ (ข้อมูลอยู่บนหน้าจอแล้ว) แต่ต้องทิ้ง log ไว้เสมอ —
 * การดึงรายการแต้มทั้งร้านออกไปเป็นไฟล์คือเหตุการณ์ที่ควรตามย้อนได้ ไม่ใช่ "สำเร็จแบบเงียบ"
 */
import { getResolvedCurrentPermissions, requireFeature, requirePermission } from "@/modules/auth/guards";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";

export async function logLoyaltyStatsExportAction(input: {
  dateFrom: string;
  dateTo: string;
  type: string | null;
  rowCount: number;
}): Promise<{ error: string | null }> {
  try {
    await requirePermission("catalog.manage");
    await requireFeature("loyaltyPoints");
    const { ctx } = await getResolvedCurrentPermissions();

    await logSystemEvent({
      level: "info",
      source: "loyalty.stats",
      action: "logLoyaltyStatsExportAction",
      message: "ส่งออก CSV สถิติแต้มลูกค้า",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: ctx.userId,
      context: {
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        type: input.type,
        rowCount: Number.isFinite(input.rowCount) ? Math.floor(input.rowCount) : 0,
      },
    });
    return { error: null };
  } catch (e) {
    logActionError({ source: "loyalty.stats", action: "logLoyaltyStatsExportAction", error: e });
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
