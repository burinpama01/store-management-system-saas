"use server";

import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import { dispatchNotification } from "@/modules/notifications/dispatcher";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return ctx;
}

export async function runNotificationDiagnosticAction(): Promise<{
  ok: boolean;
  skipped: boolean;
  message: string;
}> {
  try {
    await requirePermission("notifications.manage");
    await requireFeature("lineNotify");
    const ctx = await getStoreContext();
    const result = await dispatchNotification({
      type: "test",
      channel: "line",
      destination: "owner",
      title: "StoreOS diagnostics",
      message: "[TEST] StoreOS notification diagnostics",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
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
