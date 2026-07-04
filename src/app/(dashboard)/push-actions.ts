"use server";

import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
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
  });
  return { ok: result.ok };
}
