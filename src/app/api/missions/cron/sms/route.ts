// เรียกโดย Supabase pg_cron (ทุก 10 นาที 09–20 น. แต่ยิงมาเฉพาะเมื่อมีคิว SMS ภารกิจรอส่ง)
// กุญแจอยู่ใน Supabase Vault ตรวจผ่าน RPC — ไม่มี env ใหม่ที่ Vercel
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { runMissionSms } from "@/modules/missions/sms";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const key = req.headers.get("x-mission-sms-key") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC ใหม่ยังไม่อยู่ใน database.types
  const db: any = await createSupabaseServiceClient();
  const { data: valid, error } = key ? await db.rpc("verify_mission_sms_cron_key", { p_key: key }) : { data: false, error: null };
  if (error || valid !== true) {
    void logSystemEvent({
      level: "warn",
      source: "cron.mission-sms",
      action: "authorize",
      message: error ? "ตรวจกุญแจ cron SMS ภารกิจไม่สำเร็จ" : "ปฏิเสธการเรียก cron SMS ภารกิจ: กุญแจไม่ถูกต้อง",
    });
    return Response.json({ ok: false }, { status: 401 });
  }

  try {
    const result = await runMissionSms(50);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    logActionError({ source: "cron.mission-sms", action: "runMissionSms", error });
    return Response.json({ ok: false }, { status: 500 });
  }
}
