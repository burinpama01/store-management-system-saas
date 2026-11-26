"use server";

import { onlineOrderIdFromMetadata } from "@/modules/notifications/online-order-link";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  acknowledgeNotification,
  acknowledgeAllNotifications,
  listNotifications,
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

export interface NewNotificationItem {
  id: string;
  type: string;
  title: string | null;
  message: string;
  createdAt: string;
  /** ออเดอร์ออนไลน์ (new_online_order) — กดแจ้งเตือนแล้วเปิดตั๋วนั้นใน POS */
  onlineOrderId?: string | null;
}

/**
 * การแจ้งเตือนสถานะ "ใหม่" ล่าสุดของร้าน — ใช้เป็น polling fallback ของตัวเด้ง
 * แจ้งเตือนกลาง (กรณี realtime ใช้ไม่ได้ เช่น เน็ตร้านบล็อก WebSocket)
 */
export async function listNewNotificationsAction(): Promise<{
  notifications: NewNotificationItem[];
  error: string | null;
}> {
  try {
    await requirePermission("reports.view");
    const { ctx } = await getStoreContext();
    const res = await listNotifications(ctx.storeId, { status: "new", limit: 10 });
    if (res.error) return { notifications: [], error: res.error.userMessage };
    return {
      notifications: (res.data ?? []).map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        createdAt: n.createdAt,
        onlineOrderId: onlineOrderIdFromMetadata(n.metadata),
      })),
      error: null,
    };
  } catch (e) {
    return { notifications: [], error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
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
