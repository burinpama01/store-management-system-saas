// log จากโค้ด native ของแอป Android (รับ push / สร้างแจ้งเตือนเสียงวน / token ใหม่ / เปิดแอป)
// ฝั่ง native ไม่มีทางเขียน system_event_logs เอง — ยิงมาที่นี่พร้อม cookie ของ WebView
// ต้องล็อกอินอยู่ (session เดียวกับหน้าเว็บในแอป) กันคนนอกยิง log ขยะเข้ามา
import { getOptionalResolvedCurrentPermissions } from "@/modules/auth/guards";
import { parseAppVersionName } from "@/modules/mobile/android-version";
import { logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

/** event ที่แอปส่งได้ — อย่างอื่นทิ้ง */
const DEVICE_EVENTS: Record<string, { level: "info" | "warn"; message: string }> = {
  app_open: { level: "info", message: "เปิดแอป" },
  push_received: { level: "info", message: "แอปได้รับ push" },
  insistent_shown: { level: "info", message: "สร้างแจ้งเตือนออเดอร์แบบเสียงวนแล้ว" },
  insistent_skipped: { level: "info", message: "ไม่สร้างแจ้งเตือนเสียงวน (แอปอยู่หน้าจอ)" },
  insistent_failed: { level: "warn", message: "สร้างแจ้งเตือนเสียงวนไม่สำเร็จ" },
  token_refreshed: { level: "info", message: "เครื่องได้ FCM token ใหม่" },
  order_alerts_cancelled: { level: "info", message: "เปิดแอปแล้ว หยุดแจ้งเตือนเสียงวน" },
};

const MAX_DETAIL_KEYS = 20;

function sanitizeDetail(raw: unknown): Record<string, string | number | boolean | null> {
  const detail: Record<string, string | number | boolean | null> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return detail;
  for (const [key, value] of Object.entries(raw).slice(0, MAX_DETAIL_KEYS)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value === "string") detail[key] = value.slice(0, 200);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) detail[key] = value;
  }
  return detail;
}

export async function POST(request: Request): Promise<Response> {
  const authz = await getOptionalResolvedCurrentPermissions();
  if (!authz) return Response.json({ ok: false }, { status: 401 });

  let body: { event?: unknown; detail?: unknown };
  try {
    body = (await request.json()) as { event?: unknown; detail?: unknown };
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const event = typeof body.event === "string" ? DEVICE_EVENTS[body.event] : undefined;
  if (!event) return Response.json({ ok: false }, { status: 400 });

  const { user, ctx } = authz;
  await logSystemEvent({
    level: event.level,
    source: "mobile.android",
    action: body.event as string,
    message: event.message,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    context: {
      ...sanitizeDetail(body.detail),
      appVersion: parseAppVersionName(request.headers.get("user-agent") ?? ""),
    },
  });
  return Response.json({ ok: true });
}
