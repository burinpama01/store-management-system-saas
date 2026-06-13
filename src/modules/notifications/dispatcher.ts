import { after } from "next/server";
import type { NotificationPayload } from "./types";
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from "./types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import {
  getNotificationSetting,
  getTelegramNotificationTarget,
} from "./repository";

export interface NotificationResult {
  ok: boolean;
  skipped: boolean;
  message: string;
}

export interface TelegramSendMessageRequest {
  url: string;
  init: RequestInit;
}

const TELEGRAM_DELIVERY_TIMEOUT_MS = 5_000;

export function isNotificationPayload(input: unknown): input is NotificationPayload {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  return (
    typeof record.type === "string" &&
    typeof record.message === "string" &&
    (record.channel === undefined || typeof record.channel === "string") &&
    (record.destination === undefined || typeof record.destination === "string")
  );
}

export function validateNotificationPayload(input: NotificationPayload): string | null {
  if (!NOTIFICATION_TYPES.includes(input.type)) return "Unknown notification type";
  if (input.channel && !NOTIFICATION_CHANNELS.includes(input.channel)) return "Unknown notification channel";
  if (
    input.destination &&
    !["owner", "group", "all"].includes(input.destination)
  ) return "Unknown notification destination";
  if (!input.message.trim()) return "Notification message is required";
  if (input.message.length > 1000) return "Notification message is too long";
  if (input.channel === "telegram" && (!input.organizationId || !input.storeId)) {
    return "Telegram notification requires organization and store context";
  }
  return null;
}

function escapeTelegramHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatTelegramText(input: NotificationPayload) {
  const title = input.title?.trim();
  const lines = [
    title ? `<b>${escapeTelegramHtml(title)}</b>` : null,
    escapeTelegramHtml(input.message.trim()),
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildTelegramSendMessageRequest(
  token: string,
  chatId: string,
  input: NotificationPayload,
): TelegramSendMessageRequest {
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatTelegramText(input),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    },
  };
}

async function readTelegramProviderFailure(response: Response): Promise<string | null> {
  try {
    const json = await response.clone().json();
    if (json && typeof json === "object") {
      const record = json as Record<string, unknown>;
      if (typeof record.description === "string" && record.description.trim()) {
        return record.description.trim();
      }
      if (typeof record.message === "string" && record.message.trim()) {
        return record.message.trim();
      }
      if (typeof record.error === "string" && record.error.trim()) {
        return record.error.trim();
      }
    }
  } catch {
    // Some provider/proxy errors are plain text or empty bodies.
  }

  try {
    const text = await response.text();
    return text.trim() ? text.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

function formatTelegramDeliveryFailure(status: number, providerDetail: string | null) {
  const detail = providerDetail ? formatTelegramProviderDetail(providerDetail) : null;
  return [
    `ส่ง Telegram ไม่สำเร็จ (${status})`,
    detail,
    getTelegramSetupHint(),
  ].filter(Boolean).join(": ");
}

function formatTelegramUnavailableFailure() {
  return [
    "ส่ง Telegram ไม่สำเร็จ",
    "Telegram ยังส่งข้อความไม่ได้ในตอนนี้",
    getTelegramSetupHint(),
  ].join(": ");
}

function getTelegramSetupHint() {
  return "ตรวจสอบว่า chat ID เป็นของ Telegram group นี้ และเพิ่ม bot ชื่อ Store OS Bot (@store_os_bot) เข้ากลุ่มแล้ว";
}

function formatTelegramProviderDetail(providerDetail: string) {
  if (/chat not found/i.test(providerDetail)) return "ไม่พบ chat นี้";
  if (/forbidden|blocked|not enough rights|not a member/i.test(providerDetail)) {
    return "Store OS Bot ยังไม่มีสิทธิ์ส่งข้อความในกลุ่มนี้";
  }
  if (/unauthorized|invalid token/i.test(providerDetail)) {
    return "การเชื่อมต่อ Telegram ยังไม่พร้อมใช้งาน";
  }
  if (/too many requests|retry after|rate limit/i.test(providerDetail)) {
    return "Telegram จำกัดความถี่ชั่วคราว กรุณาลองใหม่อีกครั้ง";
  }
  return "Telegram ยังส่งข้อความไม่ได้ในตอนนี้";
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("telegram_delivery_timeout"));
    }, TELEGRAM_DELIVERY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  input: NotificationPayload,
): Promise<NotificationResult> {
  const request = buildTelegramSendMessageRequest(token, chatId, input);
  let response: Response;
  try {
    response = await fetchWithTimeout(request.url, request.init);
  } catch {
    return {
      ok: false,
      skipped: false,
      message: formatTelegramUnavailableFailure(),
    };
  }
  if (!response.ok) {
    const providerDetail = await readTelegramProviderFailure(response);
    return {
      ok: false,
      skipped: false,
      message: formatTelegramDeliveryFailure(response.status, providerDetail),
    };
  }
  return { ok: true, skipped: false, message: "ส่ง Telegram สำเร็จ" };
}

export async function resolveTelegramNotificationTarget(input: NotificationPayload) {
  if (!input.organizationId || !input.storeId) {
    return { chatId: null, message: "ยังไม่พบข้อมูลร้านสำหรับส่ง Telegram" };
  }

  const setting = await getNotificationSetting(
    input.storeId,
    input.organizationId,
    input.type,
    "telegram",
    { useServiceRole: true },
  );
  if (setting.error) {
    return { chatId: null, message: setting.error.userMessage };
  }
  if (setting.data && !setting.data.enabled) {
    return { chatId: null, message: "การแจ้งเตือนนี้ถูกปิดอยู่" };
  }

  const target = await getTelegramNotificationTarget(input.organizationId, { useServiceRole: true });
  if (target.error) {
    return { chatId: null, message: target.error.userMessage };
  }
  if (!target.data?.telegramChatId) {
    return { chatId: null, message: "ยังไม่ได้ตั้งค่า Telegram chat ID สำหรับร้านนี้" };
  }
  return { chatId: target.data.telegramChatId, message: null };
}

async function isTelegramNotificationFeatureEnabled(organizationId: string) {
  const billingState =
    (await getOrganizationBillingState(organizationId)) ?? DEFAULT_BILLING_STATE;
  return getPlanFeatures(billingState).lineNotify;
}

export async function dispatchNotification(input: NotificationPayload): Promise<NotificationResult> {
  const validation = validateNotificationPayload(input);
  if (validation) return { ok: false, skipped: false, message: validation };

  const channel = input.channel ?? "line";
  const token =
    channel === "line"
      ? process.env.LINE_CHANNEL_ACCESS_TOKEN
      : process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    const channelLabel = channel === "telegram" ? "Telegram" : "LINE";
    return {
      ok: true,
      skipped: true,
      message: `ช่องทาง ${channelLabel} ยังไม่พร้อมใช้งาน`,
    };
  }

  if (channel === "telegram") {
    if (!input.organizationId) {
      return { ok: false, skipped: false, message: "ยังไม่พบข้อมูลร้านสำหรับส่ง Telegram" };
    }
    if (!(await isTelegramNotificationFeatureEnabled(input.organizationId))) {
      return {
        ok: true,
        skipped: true,
        message: "แพ็กเกจปัจจุบันยังไม่เปิดใช้การแจ้งเตือน",
      };
    }
    const target = await resolveTelegramNotificationTarget(input);
    if (!target.chatId) {
      return { ok: true, skipped: true, message: target.message ?? "ยังไม่ได้ส่ง Telegram" };
    }
    return sendTelegramMessage(token, target.chatId, input);
  }

  return {
    ok: true,
    skipped: true,
    message: "ตรวจสอบข้อมูลแจ้งเตือนแล้ว แต่ยังไม่ได้เปิดการส่งข้อความจริงสำหรับช่องทางนี้",
  };
}

function logOwnerNotificationResult(result: NotificationResult) {
  if (!result.ok && !result.skipped) {
    console.warn("owner notification skipped", { message: result.message });
  }
}

async function runOwnerNotificationDelivery(input: NotificationPayload) {
  try {
    const result = await dispatchNotification(input);
    logOwnerNotificationResult(result);
  } catch {
    console.warn("owner notification skipped");
  }
}

export function notifyOwnerSafely(input: NotificationPayload): void {
  const payload = {
    ...input,
    channel: "telegram" as const,
    destination: "owner" as const,
  };

  try {
    after(() => runOwnerNotificationDelivery(payload));
  } catch {
    void runOwnerNotificationDelivery(payload);
  }
}
