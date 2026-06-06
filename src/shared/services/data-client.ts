import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { AppError } from "@/shared/utils/error";

export type DataResult<T> = { data: T; error: null } | { data: null; error: AppError };
interface DataClientOptions<T> {
  allowNull?: boolean;
  defaultData?: T;
}

/**
 * Wraps a Supabase query with typed error mapping.
 * Use in repository adapters to avoid repeating error handling.
 */
export async function withDataClient<T>(
  fn: (
    supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ) => Promise<{ data: T | null; error: unknown }>,
  options: DataClientOptions<T> = {},
): Promise<DataResult<T>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await fn(supabase);
  if (error) {
    return { data: null, error: mapError(error) };
  }
  if (data === null) {
    if ("defaultData" in options) {
      return { data: options.defaultData as T, error: null };
    }
    if (options.allowNull) {
      return { data: null as T, error: null };
    }
    return {
      data: null,
      error: { code: "PGRST116", message: "Not found", userMessage: "Record not found." },
    };
  }
  return { data, error: null };
}

export async function getServerClient() {
  return createSupabaseServerClient();
}
