import { NextResponse } from "next/server";
import { getOptionalResolvedCurrentPermissions, requireFeature } from "@/modules/auth/guards";
import { getCustomerDisplaySettings } from "@/modules/settings/repository";
import { describeError, logSystemEvent } from "@/modules/system/event-log";

// จอลูกค้า (/pos/display) ถามโฆษณาล่าสุดเป็นระยะ — ร้านแก้โฆษณาแล้วจอเปลี่ยนเองโดยไม่ต้องรีเฟรช
// POST = จอแจ้งว่าสื่อโฆษณาโหลดไม่ขึ้น (ลิงก์ตาย/ไฟล์ถูกลบ) เพื่อให้ผู้ดูแลเห็นใน /system/logs
// ห้ามใช้ requirePermission ตรง ๆ เพราะมัน redirect ไป /login — จอค้างต้องได้ 401 แล้วแสดงโฆษณาเดิมต่อ

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function resolveDisplayContext() {
  let permissions: Awaited<ReturnType<typeof getOptionalResolvedCurrentPermissions>>;
  try {
    permissions = await getOptionalResolvedCurrentPermissions();
  } catch {
    // ลาออก/ไม่มี membership/โหลดสิทธิ์ล้ม — ตอบ 401 แทน 500 (จอยิงทุก 5 นาที ไม่ควรสร้าง error log ซ้ำ)
    return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE }) };
  }
  if (!permissions) return { error: NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE }) };
  if (!permissions.resolved.can("pos.use")) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE }) };
  }
  try {
    await requireFeature("customerDisplay");
  } catch {
    return { error: NextResponse.json({ error: "feature_locked" }, { status: 403, headers: NO_STORE }) };
  }
  return { permissions };
}

export async function GET() {
  const { permissions, error } = await resolveDisplayContext();
  if (error) return error;
  const { ctx } = permissions;
  const res = await getCustomerDisplaySettings(ctx.storeId, ctx.organizationId);
  if (res.error) {
    void logSystemEvent({
      level: "error",
      source: "pos.customer-display",
      action: "GET /api/pos/customer-display/settings",
      message: "ดึงค่าโฆษณาจอลูกค้าไม่สำเร็จ",
      errorCode: res.error.code ?? null,
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: "load_failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ settings: res.data }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const { permissions, error } = await resolveDisplayContext();
  if (error) return error;
  const { ctx, user } = permissions;
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url.slice(0, 300) : "";
    const mediaType = body.mediaType === "video" ? "video" : "image";
    // รับเฉพาะลิงก์สื่อจริง (http/https หรือ path ในเว็บ) — กัน log ขยะ
    if (!url || !/^(https?:\/\/|\/)/i.test(url)) return NextResponse.json({ ok: false }, { status: 400, headers: NO_STORE });
    await logSystemEvent({
      level: "warn",
      source: "pos.customer-display",
      action: "reportCustomerDisplayMediaError",
      message: "สื่อโฆษณาจอลูกค้าโหลดไม่ขึ้น — จอข้ามสไลด์นี้แล้ว",
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      actorUserId: user.id,
      context: { url, mediaType, slot: typeof body.slot === "string" ? body.slot.slice(0, 20) : null },
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (err) {
    const described = describeError(err);
    return NextResponse.json({ ok: false, error: described.message }, { status: 500, headers: NO_STORE });
  }
}
