"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  acknowledgeNotification,
  acknowledgeAllNotifications,
} from "@/modules/notifications/repository";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { ctx, userId: user.id };
}

export async function acknowledgeNotificationAction(
  id: string,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("reports.view");
    const { ctx, userId } = await getStoreContext();
    const res = await acknowledgeNotification(id, ctx.storeId, userId);
    if (res.error) return { error: res.error.userMessage };
    revalidatePath("/notifications");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function acknowledgeAllNotificationsAction(): Promise<{ error: string | null }> {
  try {
    await requirePermission("reports.view");
    const { ctx, userId } = await getStoreContext();
    const res = await acknowledgeAllNotifications(ctx.storeId, userId);
    if (res.error) return { error: res.error.userMessage };
    revalidatePath("/notifications");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
