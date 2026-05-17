import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

export type UnsubscribeFn = () => void;

export type RealtimeEventType = "INSERT" | "UPDATE" | "DELETE";

export interface RealtimePayload<T> {
  eventType: RealtimeEventType;
  new: T | null;
  old: Partial<T> | null;
}

export interface RealtimeSubscriptionOptions<T> {
  client: SupabaseClient;
  table: string;
  filter?: string;
  onEvent: (payload: RealtimePayload<T>) => void;
  onError?: (error: Error) => void;
}

/**
 * Managed realtime subscription that mirrors the legacy managedOnValue() cleanup pattern.
 * Returns an unsubscribe function — always call it on component unmount.
 * DELETE events carry the deleted row in payload.old; payload.new will be null.
 */
export function managedRealtimeSubscription<T extends Record<string, unknown>>(
  options: RealtimeSubscriptionOptions<T>
): UnsubscribeFn {
  const { client, table, filter, onEvent, onError } = options;

  let channel: RealtimeChannel;

  try {
    const channelConfig = client
      .channel(`table-${table}-${Date.now()}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table,
          ...(filter ? { filter } : {}),
        },
        (raw: { new: T; old: Partial<T>; eventType: string }) => {
          const eventType = raw.eventType as RealtimeEventType;
          onEvent({
            eventType,
            new: eventType === "DELETE" ? null : raw.new,
            old: eventType === "INSERT" ? null : raw.old,
          });
        }
      );

    channel = channelConfig.subscribe((status: string) => {
      if (status === "CHANNEL_ERROR" && onError) {
        onError(new Error(`Realtime channel error for table ${table}`));
      }
    });
  } catch (err) {
    if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    return () => {};
  }

  return () => {
    client.removeChannel(channel).catch(() => {});
  };
}
