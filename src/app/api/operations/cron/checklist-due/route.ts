// เรียกโดย Supabase pg_cron (ทุก 15 นาที แต่ยิงมาเฉพาะเมื่อมีเช็กลิสต์เลยกำหนดยังไม่ส่ง)
// ใช้กุญแจ Vault ตัวเดียวกับสรุปปิดร้าน (closing_summary_cron_key) — ไม่มี env ใหม่ที่ Vercel
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { notifyOwnerNow } from "@/modules/notifications/dispatcher";
import { claimOpsNotification, listDueChecklistAlerts } from "@/modules/operations/repository";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

const SOURCE = "cron.ops-checklist-due";

export async function POST(req: Request): Promise<Response> {
  const key = req.headers.get("x-closing-summary-key") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC ยังไม่อยู่ใน database.types
  const db: any = await createSupabaseServiceClient();
  const { data: valid, error } = key ? await db.rpc("verify_closing_summary_cron_key", { p_key: key }) : { data: false, error: null };
  if (error || valid !== true) {
    void logSystemEvent({
      level: "warn",
      source: SOURCE,
      action: "authorize",
      message: error ? "ตรวจกุญแจ cron ไม่สำเร็จ" : "ปฏิเสธการเรียก cron เช็กลิสต์เลยกำหนด: กุญแจไม่ถูกต้อง",
    });
    return Response.json({ ok: false }, { status: 401 });
  }

  try {
    const alerts = await listDueChecklistAlerts();
    if (alerts.error !== null) {
      await logSystemEvent({ level: "error", source: SOURCE, action: "listDue", message: alerts.error });
      return Response.json({ ok: false }, { status: 500 });
    }

    let sent = 0;
    let failed = 0;
    for (const alert of alerts.data) {
      const claim = await claimOpsNotification(alert.dedupeKey, alert.organizationId, alert.storeId);
      if (claim.error || !claim.data) continue;
      const dueTime = alert.dueAtLocal.slice(11, 16);
      const ok = await notifyOwnerNow({
        type: "ops_checklist",
        organizationId: alert.organizationId,
        storeId: alert.storeId,
        title: "เช็กลิสต์เลยกำหนด",
        message: `“${alert.templateName}”${alert.area ? ` (${alert.area})` : ""} ยังไม่ส่ง — กำหนด ${dueTime} น.`,
        metadata: {
          event: "overdue",
          templateId: alert.templateId,
          templateName: alert.templateName,
          shiftDate: alert.shiftDate,
          itemLabel: `ยังไม่ส่ง (กำหนด ${dueTime} น.)`,
          employeeName: "-",
        },
      });
      if (ok) sent += 1;
      else failed += 1;
      await logSystemEvent({
        level: ok ? "info" : "warn",
        source: SOURCE,
        action: "notifyOverdue",
        message: ok ? `แจ้งเจ้าของ: ${alert.templateName} เลยกำหนด` : `แจ้งเจ้าของไม่ครบทุกช่องทาง: ${alert.templateName}`,
        organizationId: alert.organizationId,
        storeId: alert.storeId,
        context: { templateId: alert.templateId, shiftDate: alert.shiftDate },
      });
    }
    await logSystemEvent({
      level: "info",
      source: SOURCE,
      action: "run",
      message: `ตรวจเช็กลิสต์เลยกำหนด: ${alerts.data.length} รายการ แจ้งสำเร็จ ${sent} ไม่ครบ ${failed}`,
      context: { due: alerts.data.length, sent, failed },
    });
    return Response.json({ ok: true, due: alerts.data.length, sent, failed });
  } catch (err) {
    logActionError({ source: SOURCE, action: "run", error: err });
    return Response.json({ ok: false }, { status: 500 });
  }
}
