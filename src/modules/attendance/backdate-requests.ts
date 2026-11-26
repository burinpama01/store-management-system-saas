import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import { mapError, type AppError } from "@/shared/utils/error";

type Row = Database["public"]["Tables"]["attendance_backdate_requests"]["Row"];

export type BackdateRequestStatus = Row["status"];

/** คำขอลงเวลาย้อนหลัง — มีผลกับบันทึกเวลา/เงินเดือนเมื่อผู้จัดการอนุมัติแล้วเท่านั้น */
export interface BackdateRequest {
  id: string;
  storeId: string;
  userId: string;
  employeeName: string;
  /** แถวที่ลืมกดออกงาน (ขอแค่เวลาออก) — null = วันที่ไม่ได้ลงเวลาเลย */
  attendanceRecordId: string | null;
  date: string;
  clockInAt: string;
  clockOutAt: string;
  note: string | null;
  status: BackdateRequestStatus;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

function mapRow(row: Row): BackdateRequest {
  return {
    id: row.id,
    storeId: row.store_id,
    userId: row.user_id,
    employeeName: row.employee_name,
    attendanceRecordId: row.attendance_record_id,
    date: row.date,
    clockInAt: row.clock_in_at,
    clockOutAt: row.clock_out_at,
    note: row.note,
    status: row.status,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
  };
}

export async function listBackdateRequests(opts: {
  storeIds: string[];
  status?: BackdateRequestStatus;
  userId?: string;
  sinceDate?: string;
  limit?: number;
}): Promise<{ data: BackdateRequest[]; error: AppError | null }> {
  if (opts.storeIds.length === 0) return { data: [], error: null };
  const supabase = await createSupabaseServerClient();
  let query = supabase.from("attendance_backdate_requests").select("*").in("store_id", opts.storeIds);
  if (opts.status) query = query.eq("status", opts.status);
  if (opts.userId) query = query.eq("user_id", opts.userId);
  if (opts.sinceDate) query = query.gte("date", opts.sinceDate);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(opts.limit ?? 50);
  if (error) return { data: [], error: mapError(error) };
  return { data: (data ?? []).map(mapRow), error: null };
}

/** นับสิทธิที่ใช้ไปในเดือน (รออนุมัติ + อนุมัติแล้ว — ถูกปฏิเสธ/ยกเลิกไม่นับ) */
export async function countBackdateRequestsInMonth(userId: string, storeId: string, monthStart: string, monthEndExclusive: string): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { count } = await supabase
    .from("attendance_backdate_requests")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("user_id", userId)
    .in("status", ["pending", "approved"])
    .gte("date", monthStart)
    .lt("date", monthEndExclusive);
  return count ?? 0;
}

function rpcMessage(message: string | undefined, fallback: string): string {
  return message && /^[\u0E00-\u0E7F]/.test(message) ? message : fallback;
}

export async function submitBackdateRequest(input: {
  storeId: string;
  recordId: string | null;
  date: string | null;
  clockInAt: string | null;
  clockOutAt: string;
  note: string | null;
}): Promise<{ id: string | null; error: string | null; rawError?: string }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("request_attendance_backdate", {
    p_store_id: input.storeId,
    p_record_id: input.recordId,
    p_date: input.date,
    p_clock_in_at: input.clockInAt,
    p_clock_out_at: input.clockOutAt,
    p_note: input.note,
  });
  if (error || typeof data !== "string") {
    return { id: null, error: rpcMessage(error?.message, "ส่งคำขอไม่สำเร็จ"), rawError: error?.message };
  }
  return { id: data, error: null };
}

export async function decideBackdateRequest(input: {
  requestId: string;
  action: "approve" | "reject" | "cancel";
  note: string | null;
}): Promise<{ data: BackdateRequest | null; error: string | null; rawError?: string }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("decide_attendance_backdate", {
    p_request_id: input.requestId,
    p_action: input.action,
    p_note: input.note,
  });
  if (error || !data) {
    return { data: null, error: rpcMessage(error?.message, "ดำเนินการไม่สำเร็จ"), rawError: error?.message };
  }
  return { data: mapRow(data as Row), error: null };
}
