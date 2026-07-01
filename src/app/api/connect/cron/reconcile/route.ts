// Cron: reconcile เมนู StoreOS → JDC แบบ incremental ให้ทุก active link (#4)
// เรียกโดย Vercel Cron (แนบ Authorization: Bearer $CRON_SECRET อัตโนมัติเมื่อมี env CRON_SECRET)
import { reconcileConnectMenus } from "@/modules/connect/menu-sync";

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
  const res = await reconcileConnectMenus();
  return new Response(JSON.stringify({ ok: true, ...res }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
