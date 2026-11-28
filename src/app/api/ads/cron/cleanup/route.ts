// เรียกโดย Supabase pg_cron (ทุกชั่วโมง แต่ยิงมาเฉพาะเมื่อมีไฟล์โฆษณารอลบ)
// ลบไฟล์ของคำสั่งที่ไม่จ่าย (หลังยกเลิก 30 นาที) และโฆษณาที่หมดอายุ/ถูกถอด/ไม่อนุมัติเกิน 7 วัน
// กุญแจอยู่ใน Supabase Vault ตรวจผ่าน RPC — ไม่มี env ใหม่ที่ Vercel
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { STORE_AD_MEDIA_BUCKET } from "@/modules/ad-self-serve/server";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const key = req.headers.get("x-ad-cleanup-key") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC/ตารางใหม่ยังไม่อยู่ใน database.types
  const db: any = await createSupabaseServiceClient();
  const { data: valid, error } = key ? await db.rpc("verify_ad_cleanup_cron_key", { p_key: key }) : { data: false, error: null };
  if (error || valid !== true) {
    void logSystemEvent({
      level: "warn",
      source: "cron.ad-cleanup",
      action: "authorize",
      message: error ? "ตรวจกุญแจ cron ลบไฟล์โฆษณาไม่สำเร็จ" : "ปฏิเสธการเรียก cron ลบไฟล์โฆษณา: กุญแจไม่ถูกต้อง",
    });
    return Response.json({ ok: false }, { status: 401 });
  }

  try {
    const { data: due, error: dueError } = await db.rpc("store_ad_media_cleanup_due", { p_limit: 100 });
    if (dueError) throw new Error(dueError.message);
    const rows = (Array.isArray(due) ? due : []) as { id: string; media_path: string }[];
    if (rows.length === 0) return Response.json({ ok: true, deleted: 0 });

    const { error: removeError } = await db.storage.from(STORE_AD_MEDIA_BUCKET).remove(rows.map((r) => r.media_path));
    if (removeError) throw new Error(removeError.message);
    const now = new Date().toISOString();
    const { error: updateError } = await db
      .from("store_ad_orders")
      .update({ media_deleted_at: now, media_url: null })
      .in("id", rows.map((r) => r.id))
      .neq("status", "active");
    if (updateError) throw new Error(updateError.message);

    void logSystemEvent({
      level: "info",
      source: "cron.ad-cleanup",
      action: "cleanup",
      message: `ลบไฟล์โฆษณาที่หมดอายุ/ไม่จ่าย ${rows.length} ไฟล์`,
      context: { deleted: rows.length },
    });
    return Response.json({ ok: true, deleted: rows.length });
  } catch (error) {
    logActionError({ source: "cron.ad-cleanup", action: "cleanup", error });
    return Response.json({ ok: false }, { status: 500 });
  }
}
