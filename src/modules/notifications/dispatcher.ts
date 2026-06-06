import type { NotificationPayload } from "./types";
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from "./types";

export interface NotificationResult {
  ok: boolean;
  skipped: boolean;
  message: string;
}

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
  return null;
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
    return {
      ok: true,
      skipped: true,
      message: `${channel} notification skipped because provider token is not configured`,
    };
  }

  return {
    ok: true,
    skipped: true,
    message: `${channel} notification validated; provider delivery is not enabled in local dispatcher`,
  };
}
