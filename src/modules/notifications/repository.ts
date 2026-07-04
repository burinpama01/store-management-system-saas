import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { NotificationChannel, NotificationType } from "./types";

type NotificationSettingRow = Database["public"]["Tables"]["notification_settings"]["Row"];
type NotificationTargetRow = Database["public"]["Tables"]["notification_targets"]["Row"];
type LineAccountLinkRow = Database["public"]["Tables"]["line_account_links"]["Row"];
type LineAccountLinkSessionRow = Database["public"]["Tables"]["line_account_link_sessions"]["Row"];
type LineNotificationTargetRow = Database["public"]["Tables"]["line_notification_targets"]["Row"];
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

export interface LineAccountLink {
  id: string;
  organizationId: string;
  userId: string;
  lineUserId: string;
  status: "active" | "unlinked";
  linkedAt: string;
  unlinkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LineAccountLinkSession {
  id: string;
  organizationId: string;
  userId: string;
  nonceHash: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface LineNotificationTarget {
  id: string;
  organizationId: string;
  targetType: "user" | "group" | "room";
  targetId: string;
  lineUserId: string | null;
  status: "active" | "unlinked";
  linkedBy: string | null;
  linkedAt: string;
  unlinkedAt: string | null;
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

function mapLineAccountLink(row: LineAccountLinkRow): LineAccountLink {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    lineUserId: row.line_user_id,
    status: row.status,
    linkedAt: row.linked_at,
    unlinkedAt: row.unlinked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLineAccountLinkSession(row: LineAccountLinkSessionRow): LineAccountLinkSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    nonceHash: row.nonce_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapLineNotificationTarget(row: LineNotificationTargetRow): LineNotificationTarget {
  return {
    id: row.id,
    organizationId: row.organization_id,
    targetType: row.target_type,
    targetId: row.target_id,
    lineUserId: null,
    status: row.status,
    linkedBy: row.linked_by,
    linkedAt: row.linked_at,
    unlinkedAt: row.unlinked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLineAccountLinkTarget(row: LineAccountLinkRow): LineNotificationTarget {
  return {
    id: row.id,
    organizationId: row.organization_id,
    targetType: "user",
    targetId: row.line_user_id,
    lineUserId: row.line_user_id,
    status: row.status,
    linkedBy: row.user_id,
    linkedAt: row.linked_at,
    unlinkedAt: row.unlinked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DevicePushToken {
  id: string;
  userId: string;
  organizationId: string;
  storeId: string | null;
  platform: "android" | "ios";
  token: string;
}

export async function upsertDevicePushToken(input: {
  userId: string;
  organizationId: string;
  storeId: string | null;
  platform: "android" | "ios";
  token: string;
}) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("device_push_tokens").upsert(
    {
      user_id: input.userId,
      organization_id: input.organizationId,
      store_id: input.storeId,
      platform: input.platform,
      token: input.token,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "token" },
  );

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function listOrganizationPushTokens(organizationId: string) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("device_push_tokens")
    .select("*")
    .eq("organization_id", organizationId);

  if (error) return { data: null, error: mapError(error) };
  return {
    data: (data ?? []).map((row): DevicePushToken => ({
      id: row.id,
      userId: row.user_id,
      organizationId: row.organization_id,
      storeId: row.store_id,
      platform: row.platform,
      token: row.token,
    })),
    error: null,
  };
}

/** ลบ token ที่ FCM ตอบว่า unregistered (เครื่องถอนแอป/token หมุนใหม่) */
export async function deleteDevicePushTokens(tokens: string[]) {
  if (tokens.length === 0) return { ok: true, error: null };
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("device_push_tokens")
    .delete()
    .in("token", tokens);

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
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

export async function getLineAccountLink(
  organizationId: string,
  userId: string,
  options: NotificationRepositoryOptions = {},
) {
  const supabase = await getNotificationClient(options);
  const { data, error } = await supabase
    .from("line_account_links")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapLineAccountLink(data) : null, error: null };
}

export async function getLineOwnerAccountLinkByLineUserId(
  lineUserId: string,
  options: NotificationRepositoryOptions = {},
) {
  const supabase = await getNotificationClient({ ...options, useServiceRole: true });
  const { data, error } = await supabase
    .from("line_account_links")
    .select("*")
    .eq("line_user_id", lineUserId)
    .eq("status", "active")
    .maybeSingle();

  if (error) return { data: null, error: mapError(error) };
  if (!data) return { data: null, error: null };

  const membershipResult = await supabase
    .from("memberships")
    .select("id")
    .eq("organization_id", data.organization_id)
    .eq("user_id", data.user_id)
    .eq("role", "owner")
    .not("joined_at", "is", null)
    .maybeSingle();

  if (membershipResult.error) return { data: null, error: mapError(membershipResult.error) };
  return { data: membershipResult.data ? mapLineAccountLink(data) : null, error: null };
}

export async function getLineGroupNotificationTarget(
  organizationId: string,
  options: NotificationRepositoryOptions = {},
) {
  const supabase = await getNotificationClient(options);
  const { data, error } = await supabase
    .from("line_notification_targets")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("linked_at", { ascending: false })
    .limit(1);

  if (error) return { data: null, error: mapError(error) };
  return { data: data?.[0] ? mapLineNotificationTarget(data[0]) : null, error: null };
}

export async function getLineNotificationTarget(
  organizationId: string,
  options: NotificationRepositoryOptions = {},
) {
  const supabase = await getNotificationClient(options);
  const groupTarget = await getLineGroupNotificationTarget(organizationId, options);
  if (groupTarget.error || groupTarget.data) return groupTarget;

  const ownersResult = await supabase
    .from("memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .not("joined_at", "is", null);

  if (ownersResult.error) return { data: null, error: mapError(ownersResult.error) };
  const ownerUserIds = (ownersResult.data ?? []).map((row) => row.user_id).filter(Boolean);
  if (ownerUserIds.length === 0) return { data: null, error: null };

  const { data, error } = await supabase
    .from("line_account_links")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .in("user_id", ownerUserIds)
    .order("linked_at", { ascending: true })
    .limit(1);

  if (error) return { data: null, error: mapError(error) };
  return { data: data?.[0] ? mapLineAccountLinkTarget(data[0]) : null, error: null };
}

export async function createLineAccountLinkSession(
  organizationId: string,
  userId: string,
  nonceHash: string,
  expiresAt: string,
) {
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("line_account_link_sessions")
    .insert({
      organization_id: organizationId,
      user_id: userId,
      nonce_hash: nonceHash,
      expires_at: expiresAt,
    })
    .select("*")
    .single();

  if (error) return { data: null, error: mapError(error) };
  return { data: mapLineAccountLinkSession(data), error: null };
}

export async function consumeLineAccountLinkSession(
  nonceHash: string,
  options: NotificationRepositoryOptions = {},
) {
  const supabase = await getNotificationClient({ ...options, useServiceRole: true });
  const { data, error } = await supabase
    .from("line_account_link_sessions")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce_hash", nonceHash)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("*")
    .maybeSingle();

  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapLineAccountLinkSession(data) : null, error: null };
}

export async function upsertLineAccountLink(
  organizationId: string,
  userId: string,
  lineUserId: string,
) {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const { error } = await supabase.from("line_account_links").upsert(
    {
      organization_id: organizationId,
      user_id: userId,
      line_user_id: lineUserId,
      status: "active",
      linked_at: now,
      unlinked_at: null,
      updated_at: now,
    },
    { onConflict: "organization_id,user_id" },
  );

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function upsertLineNotificationTarget(
  organizationId: string,
  linkedBy: string,
  targetType: "group" | "room",
  targetId: string,
) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.rpc("upsert_line_notification_target", {
    p_organization_id: organizationId,
    p_linked_by: linkedBy,
    p_target_type: targetType,
    p_target_id: targetId,
  });

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function unlinkLineAccount(organizationId: string, userId: string) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("line_account_links")
    .update({
      status: "unlinked",
      unlinked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("user_id", userId);

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function unlinkLineNotificationTarget(organizationId: string) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("line_notification_targets")
    .update({
      status: "unlinked",
      unlinked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("status", "active");

  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}
