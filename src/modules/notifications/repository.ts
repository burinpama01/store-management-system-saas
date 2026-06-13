import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { NotificationChannel, NotificationType } from "./types";

type NotificationSettingRow = Database["public"]["Tables"]["notification_settings"]["Row"];
type NotificationTargetRow = Database["public"]["Tables"]["notification_targets"]["Row"];
type NotificationClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

const TELEGRAM_CHAT_ID_RE = /^-?[0-9]{5,32}$/;

export interface NotificationSetting {
  id: string;
  organizationId: string;
  storeId: string;
  type: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
  destination: "owner" | "group" | "all";
  createdAt: string;
  updatedAt: string;
}

export interface NotificationSettingInput {
  type: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
  destination?: "owner" | "group" | "all";
}

export interface TelegramNotificationTarget {
  id: string;
  organizationId: string;
  channel: "telegram";
  telegramChatId: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationRepositoryOptions {
  useServiceRole?: boolean;
}

function normalizeTelegramChatId(chatId: string) {
  const value = chatId.trim();
  return TELEGRAM_CHAT_ID_RE.test(value) ? value : null;
}

async function getNotificationClient(options: NotificationRepositoryOptions = {}): Promise<NotificationClient> {
  return options.useServiceRole
    ? await createSupabaseServiceClient()
    : await createSupabaseServerClient();
}

function mapNotificationSetting(row: NotificationSettingRow): NotificationSetting {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    type: row.notification_type,
    channel: row.channel,
    enabled: row.enabled,
    destination: row.destination,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTelegramNotificationTarget(row: NotificationTargetRow): TelegramNotificationTarget {
  return {
    id: row.id,
    organizationId: row.organization_id,
    channel: row.channel,
    telegramChatId: row.telegram_chat_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listNotificationSettings(storeId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("notification_settings")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .order("notification_type")
    .order("channel");

  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapNotificationSetting), error: null };
}

export async function upsertNotificationSetting(
  storeId: string,
  organizationId: string,
  input: NotificationSettingInput,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("notification_settings").upsert(
    {
      organization_id: organizationId,
      store_id: storeId,
      notification_type: input.type,
      channel: input.channel,
      enabled: input.enabled,
      destination: input.destination ?? "owner",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,notification_type,channel" },
  );

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function getTelegramNotificationTarget(
  organizationId: string,
  options: NotificationRepositoryOptions = {},
) {
  const supabase = await getNotificationClient(options);
  const { data, error } = await supabase
    .from("notification_targets")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("channel", "telegram")
    .maybeSingle();

  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapTelegramNotificationTarget(data) : null, error: null };
}

export async function upsertTelegramNotificationTarget(
  organizationId: string,
  telegramChatId: string,
) {
  const normalizedChatId = normalizeTelegramChatId(telegramChatId);
  if (!normalizedChatId) {
    return {
      ok: false,
      error: {
        userMessage: "Telegram chat ID ไม่ถูกต้อง",
        code: "invalid_telegram_chat_id",
        detail: "Expected a numeric Telegram chat ID, for example -1001234567890.",
      },
    };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("notification_targets").upsert(
    {
      organization_id: organizationId,
      channel: "telegram",
      telegram_chat_id: normalizedChatId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,channel" },
  );

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function getNotificationSetting(
  storeId: string,
  organizationId: string,
  type: NotificationType,
  channel: NotificationChannel,
  options: NotificationRepositoryOptions = {},
) {
  const supabase = await getNotificationClient(options);
  const { data, error } = await supabase
    .from("notification_settings")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .eq("notification_type", type)
    .eq("channel", channel)
    .maybeSingle();

  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapNotificationSetting(data) : null, error: null };
}
