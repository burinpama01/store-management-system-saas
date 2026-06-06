import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { NotificationChannel, NotificationType } from "./types";

type NotificationSettingRow = Database["public"]["Tables"]["notification_settings"]["Row"];

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
