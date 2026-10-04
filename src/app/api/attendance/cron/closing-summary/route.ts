// เรียกโดย Supabase pg_cron (ทุก 30 นาที แต่ยิงมาเฉพาะเมื่อมีสาขาถึงเวลาปิด + 1 ชม.)
// กุญแจอยู่ใน Supabase Vault ตรวจผ่าน RPC — ไม่มี env ใหม่ที่ Vercel
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { runClosingSummaries } from "@/modules/reports/closing-summary-runner";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const key = req.headers.get("x-closing-summary-key") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC ใหม่ยังไม่อยู่ใน database.types
  const db: any = await createSupabaseServiceClient();
  const { data: valid, error } = key ? await db.rpc("verify_closing_summary_cron_key", { p_key: key }) : { data: false, error: null };
  if (error || valid !== true) {
    void logSystemEvent({
      level: "warn",
      source: "cron.closing-summary",
      action: "authorize",
      message: error ? "ตรวจกุญแจ cron ไม่สำเร็จ" : "ปฏิเสธการเรียก cron สรุปเวลาปิดร้าน: กุญแจไม่ถูกต้อง",
    });
    return Response.json({ ok: false }, { status: 401 });
  }

  try {
    const result = await runClosingSummaries(new Date());
    return Response.json({ ok: true, ...result });
  } catch (error) {
    logActionError({ source: "cron.closing-summary", action: "runClosingSummaries", error });
    return Response.json({ ok: false }, { status: 500 });
  }
}
