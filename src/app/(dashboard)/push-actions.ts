"use server";

import { headers } from "next/headers";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { parseAppVersionName } from "@/modules/mobile/android-version";
import { upsertDevicePushToken } from "@/modules/notifications/repository";
import { logSystemEvent } from "@/modules/system/event-log";

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
    await logSystemEvent({
      level: "warn",
      source: "notifications.push",
      action: "registerPushToken",
      message: "ลงทะเบียน Push ไม่สำเร็จ: ข้อมูล token/platform ไม่ถูกต้อง",
      context: { platform: input?.platform ?? null },
    });
    return { ok: false };
  }

  const { user, ctx } = await getResolvedCurrentPermissions();
  if (!ctx) return { ok: false };

  // อ่านรุ่นจาก UA (StoreOSApp/x.y.z) ไม่รับจาก client — ใช้เลือกรูปแบบ push ที่แอปรุ่นนั้นรองรับ
  const appVersion = parseAppVersionName((await headers()).get("user-agent") ?? "");
  const result = await upsertDevicePushToken({
    userId: user.id,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId ?? null,
    platform: input.platform,
    token: input.token,
    appVersion,
  });
  await logSystemEvent({
    level: result.ok ? "info" : "error",
    source: "notifications.push",
    action: "registerPushToken",
    message: result.ok
      ? `ลงทะเบียน Push ${input.platform} แอป ${appVersion ?? "ไม่ทราบรุ่น"}`
      : `ลงทะเบียน Push ไม่สำเร็จ: ${result.error?.userMessage ?? "ไม่ทราบสาเหตุ"}`,
    errorCode: result.error?.code ?? null,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId ?? null,
    actorUserId: user.id,
    context: { platform: input.platform, appVersion },
  });
  return { ok: result.ok };
}

/** ขั้นตอนที่หน้าเว็บในแอปรายงาน — info = ผ่านไปตามปกติ, warn = ลงทะเบียนไม่ถึงเซิร์ฟเวอร์ */
const CLIENT_STAGES: Record<string, { level: "info" | "warn"; message: string }> = {
  start: { level: "info", message: "แอปเริ่มลงทะเบียน Push" },
  cache_hit: { level: "info", message: "แอปข้ามการลงทะเบียน Push (ลงทะเบียนแล้วภายใน 24 ชม.)" },
  bridge_missing: { level: "warn", message: "แอปลงทะเบียน Push ไม่ได้: bridge_missing" },
  plugin_missing: { level: "warn", message: "แอปลงทะเบียน Push ไม่ได้: plugin_missing" },
  permission_denied: { level: "warn", message: "แอปลงทะเบียน Push ไม่ได้: permission_denied" },
  no_token: { level: "warn", message: "แอปลงทะเบียน Push ไม่ได้: no_token" },
  client_error: { level: "warn", message: "แอปลงทะเบียน Push ไม่ได้: client_error" },
};

/**
 * แอปรายงานว่าลงทะเบียนไม่ถึงเซิร์ฟเวอร์เพราะอะไร (ปฏิเสธสิทธิ์แจ้งเตือน / ไม่ได้ token ฯลฯ)
 * — เดิมเงียบหมด ไล่ปัญหา "push ไม่มา/ไม่ดังวน" ไม่ได้เลย
 */
export async function reportPushRegistrationIssueAction(input: {
  stage: string;
  detail?: string;
}): Promise<void> {
  const stage = input ? CLIENT_STAGES[input.stage] : undefined;
  if (!stage) return;
  const { user, ctx } = await getResolvedCurrentPermissions();
  await logSystemEvent({
    level: stage.level,
    source: "notifications.push",
    action: "registerPushToken.client",
    message: stage.message,
    organizationId: ctx?.organizationId ?? null,
    storeId: ctx?.storeId ?? null,
    actorUserId: user.id,
    context: {
      stage: input.stage,
      detail: typeof input.detail === "string" ? input.detail.slice(0, 200) : null,
      appVersion: parseAppVersionName((await headers()).get("user-agent") ?? ""),
    },
  });
}
