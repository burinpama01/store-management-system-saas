// เรียกโดย Supabase pg_cron (ทุก 30 นาที เฉพาะเมื่อมีสาขาเปิดรอบเงินเดือน/แจ้งเตือน/โบนัสยอดขาย)
// กุญแจอยู่ใน Supabase Vault ตรวจผ่าน RPC — ไม่มี env ใหม่ที่ Vercel
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { runPayrollCron } from "@/modules/hr/advanced/cron";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const key = req.headers.get("x-payroll-cron-key") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC ใหม่ยังไม่อยู่ใน database.types
  const db: any = await createSupabaseServiceClient();
  const { data: valid, error } = key ? await db.rpc("verify_payroll_cron_key", { p_key: key }) : { data: false, error: null };
  if (error || valid !== true) {
    void logSystemEvent({
      level: "warn",
      source: "cron.payroll",
      action: "authorize",
      message: error ? "ตรวจกุญแจ cron เงินเดือนไม่สำเร็จ" : "ปฏิเสธการเรียก cron เงินเดือน: กุญแจไม่ถูกต้อง",
    });
    return Response.json({ ok: false }, { status: 401 });
  }

  try {
    const result = await runPayrollCron(new Date());
    return Response.json({ ok: true, ...result });
  } catch (err) {
    logActionError({ source: "cron.payroll", action: "runPayrollCron", error: err });
    return Response.json({ ok: false }, { status: 500 });
  }
}
