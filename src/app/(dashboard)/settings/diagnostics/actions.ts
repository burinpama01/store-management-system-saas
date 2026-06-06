"use server";

import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { dispatchNotification } from "@/modules/notifications/dispatcher";

export async function runNotificationDiagnosticAction(): Promise<{
  ok: boolean;
  skipped: boolean;
  message: string;
}> {
  try {
    await requirePermission("notifications.manage");
    await requireFeature("lineNotify");
    const result = await dispatchNotification({
      type: "test",
      channel: "line",
      destination: "owner",
      title: "StoreOS diagnostics",
      message: "[TEST] StoreOS notification diagnostics",
    });
    return { ok: result.ok, skipped: result.skipped, message: result.message };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      message: error instanceof Error ? error.message : "ไม่สามารถเทส notification ได้",
    };
  }
}
