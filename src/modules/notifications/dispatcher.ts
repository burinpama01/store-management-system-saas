import { after } from "next/server";
import type { NotificationPayload } from "./types";
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from "./types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import {
  deleteDevicePushTokens,
  getLineNotificationTarget,
  getNotificationSetting,
  getNotificationTemplate,
  getStoreNameForNotification,
  getTelegramNotificationTarget,
  insertNotificationLog,
  listStorePushTokens,
} from "./repository";
import { renderNotificationTemplate } from "./templates";
import { buildLinePushMessageRequest } from "./line";
import { parseServiceAccount, sendFcmToDevice } from "./push";

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

export async function resolveLineNotificationTarget(input: NotificationPayload) {
  if (!input.organizationId || !input.storeId) {
    return { targetId: null, targetType: null, message: "ยังไม่พบข้อมูลร้านสำหรับส่ง LINE" };
  }

  const setting = await getNotificationSetting(
    input.storeId,
    input.organizationId,
    input.type,
    "line",
    { useServiceRole: true },
  );
  if (setting.error) {
    return { targetId: null, targetType: null, message: setting.error.userMessage };
  }
  if (setting.data && !setting.data.enabled) {
    return { targetId: null, targetType: null, message: "การแจ้งเตือนนี้ถูกปิดอยู่" };
  }

  const target = await getLineNotificationTarget(input.organizationId, { useServiceRole: true });
  if (target.error) {
    return { targetId: null, targetType: null, message: target.error.userMessage };
  }
  if (!target.data?.targetId) {
    return { targetId: null, targetType: null, message: "ยังไม่ได้ผูก LINE สำหรับร้านนี้" };
  }
  return { targetId: target.data.targetId, targetType: target.data.targetType, message: null };
}

export async function sendLinePushMessage(
  token: string,
  targetId: string,
  input: NotificationPayload,
): Promise<NotificationResult> {
  const request = buildLinePushMessageRequest(token, targetId, input);
  let response: Response;
  try {
    response = await fetchWithTimeout(request.url, request.init);
  } catch {
    return {
      ok: false,
      skipped: false,
      message: "ส่ง LINE ไม่สำเร็จ: LINE ยังส่งข้อความไม่ได้ในตอนนี้",
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      skipped: false,
      message: `ส่ง LINE ไม่สำเร็จ (${response.status}): LINE ยังส่งข้อความไม่ได้ในตอนนี้`,
    };
  }
  return { ok: true, skipped: false, message: "ส่ง LINE สำเร็จ" };
}

async function isNotificationFeatureEnabled(organizationId: string) {
  const billingState =
    (await getOrganizationBillingState(organizationId)) ?? DEFAULT_BILLING_STATE;
  return getPlanFeatures(billingState).lineNotify;
}

async function dispatchPushNotification(input: NotificationPayload): Promise<NotificationResult> {
  const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!account) {
    return { ok: true, skipped: true, message: "ช่องทาง Push ยังไม่พร้อมใช้งาน" };
  }
  if (!input.organizationId || !input.storeId) {
    return { ok: false, skipped: false, message: "ยังไม่พบข้อมูลร้านสำหรับส่ง Push" };
  }
  if (!(await isNotificationFeatureEnabled(input.organizationId))) {
    return {
      ok: true,
      skipped: true,
      message: "แพ็กเกจปัจจุบันยังไม่เปิดใช้การแจ้งเตือน",
    };
  }

  const setting = await getNotificationSetting(
    input.storeId,
    input.organizationId,
    input.type,
    "push",
    { useServiceRole: true },
  );
  if (setting.error) {
    return { ok: true, skipped: true, message: setting.error.userMessage };
  }
  if (setting.data && !setting.data.enabled) {
    return { ok: true, skipped: true, message: "การแจ้งเตือนนี้ถูกปิดอยู่" };
  }

  // ส่งเฉพาะอุปกรณ์ที่สิทธิ์ครอบสาขาของอีเวนต์นี้ (org-wide หรือผูกสาขาเดียวกัน)
  // — เครื่องพนักงานสาขาอื่นต้องไม่เด้งออเดอร์ข้ามสาขา
  const tokensResult = await listStorePushTokens(input.organizationId, input.storeId);
  if (tokensResult.error) {
    return { ok: true, skipped: true, message: tokensResult.error.userMessage };
  }
  const tokens = tokensResult.data ?? [];
  if (tokens.length === 0) {
    return { ok: true, skipped: true, message: "ยังไม่มีอุปกรณ์ที่ลงทะเบียนรับ Push" };
  }

  const outcomes = await Promise.all(
    tokens.map(async (device) => ({
      token: device.token,
      outcome: await sendFcmToDevice(account, device.token, input),
    })),
  );

  const unregistered = outcomes
    .filter((o) => o.outcome === "unregistered")
    .map((o) => o.token);
  if (unregistered.length > 0) {
    await deleteDevicePushTokens(unregistered);
  }

  const sentCount = outcomes.filter((o) => o.outcome === "sent").length;
  if (sentCount === 0) {
    return { ok: false, skipped: false, message: "ส่ง Push ไม่สำเร็จ: ไม่มีอุปกรณ์ที่ส่งถึงได้" };
  }
  return { ok: true, skipped: false, message: `ส่ง Push สำเร็จ ${sentCount} อุปกรณ์` };
}

export async function dispatchNotification(input: NotificationPayload): Promise<NotificationResult> {
  const validation = validateNotificationPayload(input);
  if (validation) return { ok: false, skipped: false, message: validation };

  const channel = input.channel ?? "line";

  if (channel === "push") {
    return dispatchPushNotification(input);
  }

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
    if (!(await isNotificationFeatureEnabled(input.organizationId))) {
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

  if (!input.organizationId) {
    return { ok: false, skipped: false, message: "ยังไม่พบข้อมูลร้านสำหรับส่ง LINE" };
  }
  if (!(await isNotificationFeatureEnabled(input.organizationId))) {
    return {
      ok: true,
      skipped: true,
      message: "แพ็กเกจปัจจุบันยังไม่เปิดใช้การแจ้งเตือน",
    };
  }
  const target = await resolveLineNotificationTarget(input);
  if (!target.targetId) {
    return { ok: true, skipped: true, message: target.message ?? "ยังไม่ได้ส่ง LINE" };
  }
  return sendLinePushMessage(token, target.targetId, input);
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

const STORE_NAME_TTL_MS = 60_000;
const storeNameCache = new Map<string, { name: string | null; at: number }>();

async function getStoreNameCached(storeId: string): Promise<string | null> {
  const now = Date.now();
  const hit = storeNameCache.get(storeId);
  if (hit && now - hit.at < STORE_NAME_TTL_MS) return hit.name;
  const name = await getStoreNameForNotification(storeId);
  storeNameCache.set(storeId, { name, at: now });
  return name;
}

/**
 * เตรียมหัวข้อ/ข้อความสุดท้ายก่อนส่ง: ใช้ template ที่ร้านตั้งเอง (ถ้ามี) แทนค่า
 * ตัวแปรจาก metadata + {store}, แล้วเติมชื่อร้านนำหน้าหัวข้อให้เห็นทุกช่องทางเสมอ
 */
async function renderOwnerNotification(input: NotificationPayload): Promise<NotificationPayload> {
  let title = input.title;
  let message = input.message;
  let storeName: string | null = null;

  // การเตรียมข้อความ (ชื่อร้าน/template) ต้องไม่บล็อกการส่งเด็ดขาด — พังเมื่อไรใช้ค่าเดิม
  try {
    if (input.storeId) {
      storeName = await getStoreNameCached(input.storeId);
    }
    if (input.storeId && input.organizationId) {
      const template = await getNotificationTemplate(
        input.storeId,
        input.organizationId,
        input.type,
        { useServiceRole: true },
      );
      if (template.data) {
        const vars = { store: storeName ?? "", ...(input.metadata ?? {}) };
        if (template.data.title) {
          const rendered = renderNotificationTemplate(template.data.title, vars);
          if (rendered) title = rendered;
        }
        if (template.data.message) {
          const rendered = renderNotificationTemplate(template.data.message, vars);
          if (rendered) message = rendered;
        }
      }
    }
  } catch {
    // best-effort: ใช้หัวข้อ/ข้อความที่ call site ส่งมา
  }

  if (storeName) {
    title = title ? `${storeName} · ${title}` : storeName;
  }

  return { ...input, title, message };
}

async function runOwnerNotificationDeliveries(input: NotificationPayload) {
  // เตรียมข้อความ (ชื่อร้าน/template) พร้อมกันกับการ fan-out ช่องทาง เพื่อไม่ให้
  // การ resolve ข้อความไปหน่วงการส่งแบบขนานของแต่ละช่องทาง
  const renderedPromise = renderOwnerNotification(input);
  const channels = input.channel ? [input.channel] : NOTIFICATION_CHANNELS;

  // เก็บ log ในแอป (ศูนย์แจ้งเตือน) แบบ best-effort — ไม่บล็อกการส่งช่องทาง
  const persistPromise = (async () => {
    if (input.type === "test" || !input.organizationId) return;
    try {
      const rendered = await renderedPromise;
      await insertNotificationLog({
        organizationId: input.organizationId,
        storeId: input.storeId ?? null,
        type: input.type,
        title: rendered.title ?? null,
        message: rendered.message,
        metadata: input.metadata ?? null,
      });
    } catch {
      // best-effort — การเก็บ log พังต้องไม่กระทบการส่งแจ้งเตือน
    }
  })();

  await Promise.allSettled([
    persistPromise,
    ...channels.map(async (channel) => {
      const rendered = await renderedPromise;
      return runOwnerNotificationDelivery({
        ...rendered,
        channel,
        destination: "owner" as const,
      });
    }),
  ]);
}

export function notifyOwnerSafely(input: NotificationPayload): void {
  try {
    after(() => runOwnerNotificationDeliveries(input));
  } catch {
    void runOwnerNotificationDeliveries(input);
  }
}

/** เหมือน notifyOwnerSafely แต่ await ให้ส่งเสร็จ — ใช้ในงาน cron ที่ไม่มี request lifecycle */
export async function notifyOwnerNow(input: NotificationPayload): Promise<void> {
  try {
    await runOwnerNotificationDeliveries(input);
  } catch {
    // best-effort
  }
}
