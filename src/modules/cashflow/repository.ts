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

function cashIntoDrawer(payment: { amount: number | null; received_amount: number | null; change_amount: number | null }): number {
  if (payment.received_amount !== null && payment.change_amount !== null) {
    return payment.received_amount - payment.change_amount;
  }
  return payment.amount ?? 0;
}

/**
 * เงินสดในลิ้นชัก "ตอนนี้" แบบผูกกับรอบเงินสด (session-aware):
 *  - มีรอบเปิดอยู่ = เงินเปิดร้าน (opening float) + เงินสดที่เคลื่อนไหวตั้งแต่เปิดรอบ
 *    (ยอดขายเงินสด POS + รายรับ/จ่ายเงินสดที่บันทึกมือ) — คิดจากส่วนต่าง balance ใน ledger
 *  - ไม่มีรอบเปิด = ยอดเงินนับจริงตอนปิดรอบล่าสุด (closing_count) หรือ 0
 *
 * ต่างจาก getLatestCashBalance (ยอดสะสมข้ามรอบใน ledger ที่ไม่รวมเงินเปิดร้าน) ซึ่งใช้
 * ต่อยอด ledger เท่านั้น ไม่ใช่เงินในลิ้นชักจริง — เดิมทำให้ยอดติดลบเมื่อจ่ายเงินสดมากกว่า
 * ยอดขายเงินสดที่บันทึก (เพราะเงินเปิดร้านไม่ถูกนับ).
 */
export async function getCurrentCashDrawer(storeId: string): Promise<number> {
  const supabase = await createSupabaseServerClient();

  const { data: openRow } = await supabase
    .from("cash_sessions")
    .select("opening_float, opened_at")
    .eq("store_id", storeId)
    .eq("status", "open")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (openRow) {
    const latestBalance = await ledgerBalance(supabase, storeId, null);
    const balanceAtOpen = await ledgerBalance(supabase, storeId, openRow.opened_at);
    return Math.round((openRow.opening_float + (latestBalance - balanceAtOpen)) * 100) / 100;
  }

  // ไม่มีรอบเปิดอยู่ — แสดงยอดที่นับจริงตอนปิดรอบล่าสุด
  const { data: closedRow } = await supabase
    .from("cash_sessions")
    .select("closing_count")
    .eq("store_id", storeId)
    .eq("status", "closed")
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return closedRow?.closing_count ?? 0;
}

/**
 * balance_after ของ cash_ledger ล่าสุด (before = null) หรือก่อนเวลาที่กำหนด (ใช้หา balance
 * ณ ตอนเปิดรอบ). ledger เก็บ balance_after สะสม → ส่วนต่างจึงเท่ากับเงินสดที่เคลื่อนไหวจริง
 * (รวมทั้ง pos_sale / income / expense / adjustment) โดยไม่ต้องเดาเครื่องหมาย.
 */
async function ledgerBalance(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  storeId: string,
  before: string | null,
): Promise<number> {
  let query = supabase
    .from("cash_ledger_entries")
    .select("balance_after")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (before) query = query.lt("created_at", before);
  const { data } = await query.maybeSingle();
  return data?.balance_after ?? 0;
}

/**
 * POS cash collected since a given time (net cash into drawer = received - change).
 * Used to preview the expected drawer total while a session is still open.
 */
export async function getCashSalesSince(storeId: string, since: string): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("payments")
    .select("amount, received_amount, change_amount, orders!inner(store_id)")
    .eq("orders.store_id", storeId)
    .eq("method", "cash")
    .eq("status", "completed")
    .gte("processed_at", since);
  if (error || !data) return 0;
  return data.reduce((sum, payment) => sum + cashIntoDrawer(payment), 0);
}
