"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationType,
} from "@/modules/notifications/types";
import { upsertNotificationSetting } from "@/modules/notifications/repository";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return ctx;
}

function pickNotificationType(value: FormDataEntryValue | null): NotificationType {
  if (typeof value === "string" && NOTIFICATION_TYPES.includes(value as NotificationType)) {
    return value as NotificationType;
  }
  throw new Error("ประเภท notification ไม่ถูกต้อง");
}

function pickNotificationChannel(value: FormDataEntryValue | null): NotificationChannel {
  if (typeof value === "string" && NOTIFICATION_CHANNELS.includes(value as NotificationChannel)) {
    return value as NotificationChannel;
  }
  throw new Error("ช่องทาง notification ไม่ถูกต้อง");
}

export async function toggleNotificationSettingAction(formData: FormData): Promise<void> {
  await requirePermission("notifications.manage");
  const ctx = await getStoreContext();
  const type = pickNotificationType(formData.get("type"));
  const channel = pickNotificationChannel(formData.get("channel"));
  const enabled = formData.get("enabled") === "on";

  const result = await upsertNotificationSetting(ctx.storeId, ctx.organizationId, {
    type,
    channel,
    enabled,
  });
  if (result.error) throw new Error(result.error.userMessage);
  revalidatePath("/settings/notifications");
}
