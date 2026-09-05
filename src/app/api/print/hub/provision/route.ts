// Print Hub auto-provision (v0.44.11) — POST /api/print/hub/provision
//
// เครื่องร้านเจอ 401 แล้วแก้เองไม่ได้ ต้องให้คนไปกดสร้าง token ใหม่ในหน้าตั้งค่า
// แล้วก๊อป config ไปวางเอง ทุกครั้งที่ token เพี้ยน — endpoint นี้ทำให้ Launcher
// ขอ config ล่าสุดของ "เครื่องตัวเอง" ได้ตอนเปิดโปรแกรม
//
// ตัวตนที่ใช้คือ session ของผู้ใช้ที่ล็อกอินใน WebView2 ของ Launcher เท่านั้น
// (ไม่ใช่ hub token — ไม่งั้นเครื่องที่ token เพี้ยนก็จะขอใหม่ไม่ได้อยู่ดี)
// จึงต้องมีสิทธิ์จัดการเครื่องพิมพ์ และได้ config ของร้านที่ตัวเองใช้อยู่เท่านั้น
//
// idempotent: ถ้า token ที่เครื่องถืออยู่ยังใช้ได้ จะไม่ออกใบใหม่ (rotated=false)
// เพื่อไม่ให้การเปิดโปรแกรมทุกครั้งกลายเป็นการสร้าง token รัว ๆ
import { NextResponse } from "next/server";
import { z } from "zod";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import {
  MAX_HUB_DEVICE_ID_LENGTH,
  provisionHubDeviceToken,
} from "@/modules/printing/print-hub-repository";
import { logSystemEvent } from "@/modules/system/event-log";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const RequestSchema = z
  .object({
    deviceId: z.string().min(8).max(MAX_HUB_DEVICE_ID_LENGTH),
    deviceLabel: z.string().max(120).optional(),
    /** token ที่เครื่องถืออยู่ (ถ้ามี) — ใช้ตัดสินว่าต้องออกใบใหม่ไหม */
    currentToken: z.string().max(200).optional(),
  })
  .strict();

function fail(reason: string, status: number) {
  return NextResponse.json({ ok: false, reason }, { status, headers: NO_STORE });
}

export async function POST(request: Request) {
  const authz = await getResolvedCurrentPermissions();
  if (!authz) return fail("unauthorized", 401);
  const { ctx, user, resolved } = authz;
  if (!resolved.can("settings.manage_printer") && !resolved.can("settings.manage_store")) {
    return fail("forbidden", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("invalid_body", 400);
  }
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) return fail("invalid_body", 400);

  const result = await provisionHubDeviceToken({
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    deviceId: parsed.data.deviceId,
    deviceLabel: parsed.data.deviceLabel ?? null,
    currentToken: parsed.data.currentToken ?? null,
    createdBy: user.id,
  });
  if (result.error || !result.data) return fail("provision_failed", 500);

  await logSystemEvent({
    level: "info",
    source: "printing.hub",
    action: "provisionDeviceToken",
    message: result.data.rotated
      ? "ออก Print Hub token ใหม่ให้เครื่องนี้"
      : "เครื่องนี้ใช้ Print Hub token เดิมได้อยู่แล้ว",
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
    actorUserId: user.id,
    // ไม่มี token อยู่ใน log — เก็บแค่ว่าเครื่องไหนและผลเป็นอะไร
    context: { deviceLabel: parsed.data.deviceLabel ?? null, rotated: result.data.rotated },
  });

  // config ที่ Launcher เอาไปเขียนไฟล์ได้ตรง ๆ
  return NextResponse.json(
    {
      ok: true,
      rotated: result.data.rotated,
      config: result.data.rotated
        ? {
            serverUrl: new URL(request.url).origin,
            storeId: ctx.storeId,
            hubToken: result.data.token,
            pollIntervalMs: 2500,
          }
        : null,
    },
    { headers: NO_STORE },
  );
}
