/**
 * employee_self_info — อ่าน/เขียนผ่าน client ของผู้ใช้ (RLS: แถวตัวเอง หรือ attendance.manage อ่านได้)
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import { logSystemEvent } from "@/modules/system/event-log";
import type { Database } from "@/server/integrations/supabase/database.types";
import { SELF_INFO_COLUMN, describeSelfInfoChanges, type EmployeeSelfInfo, type SelfInfoChange, type SelfInfoField, type SelfInfoPatch } from "./self-info";

type SelfRow = Database["public"]["Tables"]["employee_self_info"]["Row"];

export function mapSelfInfo(row: SelfRow): EmployeeSelfInfo {
  return {
    storeId: row.store_id,
    userId: row.user_id,
    fullName: row.full_name ?? undefined,
    bankName: row.bank_name ?? undefined,
    bankAccountNo: row.bank_account_no ?? undefined,
    bankAccountName: row.bank_account_name ?? undefined,
    nickname: row.nickname ?? undefined,
    phone: row.phone ?? undefined,
    birthDate: row.birth_date ?? undefined,
    address: row.address ?? undefined,
    emergencyContactName: row.emergency_contact_name ?? undefined,
    emergencyContactPhone: row.emergency_contact_phone ?? undefined,
    updatedAt: row.updated_at,
  };
}

/** ทุกแถวที่ผู้ใช้อ่านได้ในสาขา (ผู้จัดการ = ทุกคน, พนักงาน = ของตัวเอง) */
export async function listEmployeeSelfInfo(storeId: string): Promise<Map<string, EmployeeSelfInfo>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("employee_self_info").select("*").eq("store_id", storeId);
  // ข้อมูลเสริม: อ่านไม่ได้ไม่ควรทำให้หน้าสลิป/พนักงานพัง — แต่ต้องทิ้ง log ไม่ให้เงียบ
  if (error) {
    await logSystemEvent({
      level: "warn",
      source: "hr.self-info",
      action: "listEmployeeSelfInfo",
      message: `อ่านข้อมูลที่พนักงานกรอกเองไม่สำเร็จ: ${error.message}`,
      storeId,
      context: { code: error.code },
    }).catch(() => undefined);
    return new Map();
  }
  if (!data) return new Map();
  return new Map(data.map((row) => [row.user_id, mapSelfInfo(row)]));
}

export async function getMySelfInfo(storeId: string, userId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("employee_self_info")
    .select("*")
    .eq("store_id", storeId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error).userMessage };
  return { data: data ? mapSelfInfo(data) : null, error: null };
}

function toColumns(patch: SelfInfoPatch): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const key of Object.keys(patch) as SelfInfoField[]) {
    if (patch[key] !== undefined) values[SELF_INFO_COLUMN[key]] = patch[key] ?? null;
  }
  return values;
}

export async function saveMySelfInfo(scope: { organizationId: string; storeId: string; userId: string }, patch: SelfInfoPatch) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("employee_self_info").upsert(
    { organization_id: scope.organizationId, store_id: scope.storeId, user_id: scope.userId, ...toColumns(patch) },
    { onConflict: "store_id,user_id" },
  );
  if (!error) return { error: null };
  // ช่องมีค่าแล้วระหว่างที่เปิดฟอร์มค้าง (trigger ปฏิเสธ)
  if (error.code === "42501") return { error: "ข้อมูลบางช่องถูกกรอกไปแล้ว กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง" };
  return { error: mapError(error).userMessage };
}

/** ส่งคำขอแก้ช่องที่กรอกแล้ว (แทนที่คำขอค้างเดิม) */
export async function submitSelfInfoRequest(storeId: string, patch: SelfInfoPatch) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("submit_employee_self_info_request", {
    p_store_id: storeId,
    p_changes: toColumns(patch),
  });
  if (!error) return { error: null };
  // 22023 = ข้อความภาษาไทยจาก RPC ที่ตั้งใจให้ผู้ใช้อ่าน
  if (error.code === "22023") return { error: error.message };
  return { error: mapError(error).userMessage };
}

export async function cancelSelfInfoRequest(requestId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("cancel_employee_self_info_request", { p_request_id: requestId });
  if (!error) return { error: null };
  if (error.code === "P0002") return { error: "คำขอนี้ถูกดำเนินการไปแล้ว" };
  return { error: mapError(error).userMessage };
}

export async function reviewSelfInfoRequest(requestId: string, approve: boolean, note: string | null) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("review_employee_self_info_request", {
    p_request_id: requestId,
    p_approve: approve,
    p_note: note,
  });
  if (!error) return { error: null };
  if (error.code === "P0002") return { error: "คำขอนี้ถูกดำเนินการไปแล้ว" };
  if (error.code === "42501") return { error: "ไม่มีสิทธิ์อนุมัติคำขอนี้" };
  // ค่าในคำขอผิดรูปแบบ (เลขบัญชี/วันที่/ความยาว) — ให้ปฏิเสธคำขอแทน
  if (error.code === "23514" || error.code === "22007" || error.code === "22008" || error.code === "22P02") {
    return { error: "ข้อมูลในคำขอไม่ถูกต้อง อนุมัติไม่ได้ — กดปฏิเสธแล้วให้พนักงานส่งใหม่" };
  }
  return { error: mapError(error).userMessage };
}

export interface SelfInfoRequestView {
  id: string;
  userId: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  changes: SelfInfoChange[];
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

function mapRequest(row: Database["public"]["Tables"]["employee_self_info_requests"]["Row"]): SelfInfoRequestView {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status as SelfInfoRequestView["status"],
    // แปลงแล้ว: เลขบัญชีปิดหลัก ปลอดภัยที่จะส่งไป browser
    changes: describeSelfInfoChanges(row.changes),
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

/** คำขอรออนุมัติทั้งสาขา (สำหรับผู้จัดการ) */
export async function listPendingSelfInfoRequests(storeId: string): Promise<SelfInfoRequestView[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("employee_self_info_requests")
    .select("*")
    .eq("store_id", storeId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) {
    await logSystemEvent({
      level: "warn",
      source: "hr.self-info",
      action: "listPendingSelfInfoRequests",
      message: `อ่านคำขอแก้ข้อมูลไม่สำเร็จ: ${error.message}`,
      storeId,
      context: { code: error.code },
    }).catch(() => undefined);
    return [];
  }
  return (data ?? []).map(mapRequest);
}

/** คำขอล่าสุดของตัวเอง — เพื่อแสดงสถานะรออนุมัติ/ถูกปฏิเสธ */
export async function getMyLatestSelfInfoRequest(storeId: string, userId: string): Promise<SelfInfoRequestView | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("employee_self_info_requests")
    .select("*")
    .eq("store_id", storeId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return mapRequest(data);
}
