"use server";

import { revalidatePath } from "next/cache";
import { requireFeature, requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
  type NotificationType,
} from "@/modules/notifications/types";
import {
  unlinkLineAccount,
  unlinkLineNotificationTarget,
  upsertNotificationSetting,
  upsertTelegramNotificationTarget,
} from "@/modules/notifications/repository";
import { dispatchNotification } from "@/modules/notifications/dispatcher";
import type { ActionFeedbackState } from "./feedback";

function actionError(error: unknown, fallback: string): ActionFeedbackState {
  return {
    status: "error",
    message: error instanceof Error ? error.message : fallback,
    submittedAt: Date.now(),
  };
}

type NotificationDispatchResult = Awaited<ReturnType<typeof dispatchNotification>>;

function formatTelegramTestFeedback(result: NotificationDispatchResult) {
  if (result.ok && !result.skipped) {
    return "ส่ง Telegram test แล้ว";
  }
  if (result.skipped) {
    return formatTelegramTestSkippedFeedback(result.message);
  }

  return formatTelegramTestFailureFeedback(result.message);
}

function formatTelegramTestSkippedFeedback(message: string) {
  if (/chat ID/i.test(message)) return "ยังไม่ได้ตั้งค่า Telegram chat ID สำหรับร้านนี้";
  if (/package|แพ็กเกจ/i.test(message)) return "แพ็กเกจปัจจุบันยังไม่เปิดใช้การแจ้งเตือน";
  if (/event is disabled|ถูกปิด/i.test(message)) return "การแจ้งเตือนทดสอบ Telegram ถูกปิดอยู่";
  if (/พร้อมใช้งาน/i.test(message)) return "ช่องทาง Telegram ยังไม่พร้อมใช้งาน";
  if (/tenant context|organization context|ข้อมูลร้าน/i.test(message)) return "ยังไม่พบข้อมูลร้านสำหรับทดสอบ Telegram";
  return "ยังไม่พร้อมสำหรับทดสอบ Telegram";
}

function formatTelegramTestFailureFeedback(message: string) {
  if (message.startsWith("ส่ง Telegram ไม่สำเร็จ")) return message;
  if (/chat ID/i.test(message)) return "ยังไม่ได้ตั้งค่า Telegram chat ID สำหรับร้านนี้";
  if (/tenant context|organization context|ข้อมูลร้าน/i.test(message)) return "ยังไม่พบข้อมูลร้านสำหรับทดสอบ Telegram";
  return "ส่ง Telegram test ไม่สำเร็จ กรุณาตรวจสอบ Telegram group และ Store OS Bot";
}

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return ctx;
}

async function requireTelegramOwnerContext() {
  const ctx = await getStoreContext();
  if (ctx.role !== "owner") {
    throw new Error("ต้องเป็น owner จึงจะตั้งค่า Telegram chat ID ได้");
  }
  return ctx;
}

async function requireLineOwnerContext() {
  const ctx = await getStoreContext();
  if (ctx.role !== "owner") {
    throw new Error("ต้องเป็น owner จึงจะจัดการ LINE group ได้");
  }
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

export async function toggleNotificationSettingAction(
  _prevState: ActionFeedbackState,
  formData: FormData,
): Promise<ActionFeedbackState> {
  try {
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
    return {
      status: "success",
      message: "บันทึกการตั้งค่าแจ้งเตือนแล้ว",
      submittedAt: Date.now(),
    };
  } catch (error) {
    return actionError(error, "บันทึกการตั้งค่าแจ้งเตือนไม่สำเร็จ");
  }
}

export async function saveTelegramChatIdAction(
  _prevState: ActionFeedbackState,
  formData: FormData,
): Promise<ActionFeedbackState> {
  try {
    await requirePermission("notifications.manage");
    const ctx = await requireTelegramOwnerContext();
    const chatId = formData.get("telegramChatId");
    if (typeof chatId !== "string") throw new Error("Telegram chat ID ไม่ถูกต้อง");

    const result = await upsertTelegramNotificationTarget(ctx.organizationId, chatId);
    if (result.error) throw new Error(result.error.userMessage);
    revalidatePath("/settings/notifications");
    return {
      status: "success",
      message: "บันทึก Telegram chat ID แล้ว",
      submittedAt: Date.now(),
    };
  } catch (error) {
    return actionError(error, "บันทึก Telegram chat ID ไม่สำเร็จ");
  }
}

export async function runTelegramNotificationTestAction(): Promise<{
  ok: boolean;
  skipped: boolean;
  message: string;
}> {
  try {
    await requirePermission("notifications.manage");
    await requireFeature("lineNotify");
    const ctx = await requireTelegramOwnerContext();
    const result = await dispatchNotification({
      type: "test",
      channel: "telegram",
      destination: "owner",
      title: "StoreOS Telegram test",
      message: "[TEST] Telegram notification พร้อมใช้งาน",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
    });
    return { ok: result.ok, skipped: result.skipped, message: formatTelegramTestFeedback(result) };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      message: error instanceof Error ? error.message : "ไม่สามารถเทส Telegram notification ได้",
    };
  }
}

export async function unlinkLineAccountAction(): Promise<void> {
  await requirePermission("notifications.manage");
  const ctx = await getStoreContext();
  const result = await unlinkLineAccount(ctx.organizationId, ctx.userId);
  if (result.error) throw new Error(result.error.userMessage);
  revalidatePath("/settings/notifications");
}

export async function unlinkLineNotificationTargetAction(): Promise<void> {
  await requirePermission("notifications.manage");
  const ctx = await requireLineOwnerContext();
  const result = await unlinkLineNotificationTarget(ctx.organizationId);
  if (result.error) throw new Error(result.error.userMessage);
  revalidatePath("/settings/notifications");
}
