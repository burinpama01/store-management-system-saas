import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { CashSession, CashSessionStatus } from "./types";
import type { Database } from "@/server/integrations/supabase/database.types";

type CashSessionRow = Database["public"]["Tables"]["cash_sessions"]["Row"];

function mapSession(row: CashSessionRow): CashSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    status: row.status as CashSessionStatus,
    openingFloat: row.opening_float,
    openedByUserId: row.opened_by_user_id,
    openedAt: row.opened_at,
    openNote: row.open_note ?? undefined,
    closingCount: row.closing_count ?? undefined,
    cashSales: row.cash_sales ?? undefined,
    expectedCash: row.expected_cash ?? undefined,
    variance: row.variance ?? undefined,
    closedByUserId: row.closed_by_user_id ?? undefined,
    closedAt: row.closed_at ?? undefined,
    closeNote: row.close_note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The currently open cash session for the store, if any. */
export async function getOpenCashSession(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("cash_sessions")
    .select("*")
    .eq("store_id", storeId)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapSession(data) : null, error: null };
}

export async function listCashSessions(storeId: string, opts: { limit?: number } = {}) {
  const supabase = await createSupabaseServerClient();
  const limit = Math.min(opts.limit ?? 30, 200);
  const { data, error } = await supabase
    .from("cash_sessions")
    .select("*")
    .eq("store_id", storeId)
    .order("opened_at", { ascending: false })
    .limit(limit);
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapSession), error: null };
}

export async function openCashSession(storeId: string, openingFloat: number, note?: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("open_cash_session", {
    p_store_id: storeId,
    p_opening_float: openingFloat,
    p_note: note ?? null,
  });
  if (error) return { data: null, error: mapError(error) };
  return { data, error: null };
}

export async function closeCashSession(
  sessionId: string,
  storeId: string,
  closingCount: number,
  note?: string,
) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("close_cash_session", {
    p_session_id: sessionId,
    p_store_id: storeId,
    p_closing_count: closingCount,
    p_note: note ?? null,
  });
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapSession(data) : null, error: null };
}

/**
 * POS cash collected since a given time (net cash into drawer = payments.amount).
 * Used to preview the expected drawer total while a session is still open.
 */
export async function getCashSalesSince(storeId: string, since: string): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payments")
    .select("amount, orders!inner(store_id)")
    .eq("orders.store_id", storeId)
    .eq("method", "cash")
    .eq("status", "completed")
    .gte("processed_at", since);
  if (error || !data) return 0;
  return data.reduce((sum, row) => sum + (row.amount ?? 0), 0);
}
