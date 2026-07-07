// Cron: แจ้งเตือนโต๊ะบุฟเฟต์ที่ session ใกล้หมดเวลา
// เรียกโดย Vercel Cron (แนบ Authorization: Bearer $CRON_SECRET อัตโนมัติเมื่อมี env CRON_SECRET)
import { notifyBuffetExpiringSoon } from "@/modules/notifications/buffet-expiry";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const res = await notifyBuffetExpiringSoon();
  return new Response(JSON.stringify({ ok: true, ...res }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
