// POST /api/device-login/start — เครื่องร้านขอคำขอเข้าใช้ด้วย QR (public: ยังไม่มีใครล็อกอิน)
// คืน requestId + รหัสสั้น (แสดงบนจอ/ใน QR) + รหัสลับของเครื่อง (เก็บในหน้าเว็บเท่านั้น)
import { NextResponse } from "next/server";
import { createDeviceLoginRequest, DeviceLoginRateLimitError, hashClientIp } from "@/modules/auth/device-login";
import { logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { deviceLabel?: unknown };
  try {
    const created = await createDeviceLoginRequest({
      deviceLabel: body.deviceLabel,
      userAgent: request.headers.get("user-agent"),
      ipHash: hashClientIp(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip")),
    });
    const origin = new URL(request.url).origin;
    const approveUrl = `${origin}/device-login/approve?r=${created.requestId}&c=${encodeURIComponent(created.code)}`;
    return NextResponse.json({ ...created, approveUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DeviceLoginRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429, headers: { "Retry-After": "120" } });
    }
    void logSystemEvent({
      level: "error",
      source: "auth.device-login",
      action: "start",
      message: error instanceof Error ? error.message : "start failed",
    });
    return NextResponse.json({ error: "สร้าง QR เข้าใช้ไม่สำเร็จ ลองใหม่อีกครั้ง" }, { status: 500 });
  }
}
