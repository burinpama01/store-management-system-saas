"use server";

import { headers } from "next/headers";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { parseAppVersionName } from "@/modules/mobile/android-version";
import { upsertDevicePushToken } from "@/modules/notifications/repository";

const FCM_TOKEN_RE = /^[A-Za-z0-9_:\-]{20,512}$/;

/** แอปมือถือ (Capacitor) เรียกหลัง login เพื่อผูก FCM token กับ user/org ปัจจุบัน */
export async function registerPushTokenAction(input: {
  token: string;
  platform: "android" | "ios";
}): Promise<{ ok: boolean }> {
  if (
    !input ||
    typeof input.token !== "string" ||
    !FCM_TOKEN_RE.test(input.token) ||
    (input.platform !== "android" && input.platform !== "ios")
  ) {
    return { ok: false };
  }

  const { user, ctx } = await getResolvedCurrentPermissions();
  if (!ctx) return { ok: false };

  const result = await upsertDevicePushToken({
    userId: user.id,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId ?? null,
    platform: input.platform,
    token: input.token,
    // อ่านรุ่นจาก UA (StoreOSApp/x.y.z) ไม่รับจาก client — ใช้เลือกรูปแบบ push ที่แอปรุ่นนั้นรองรับ
    appVersion: parseAppVersionName((await headers()).get("user-agent") ?? ""),
  });
  return { ok: result.ok };
}
