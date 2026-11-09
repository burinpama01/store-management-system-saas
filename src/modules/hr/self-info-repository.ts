/**
 * employee_self_info — อ่าน/เขียนผ่าน client ของผู้ใช้ (RLS: แถวตัวเอง หรือ attendance.manage อ่านได้)
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import { logSystemEvent } from "@/modules/system/event-log";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { EmployeeSelfInfo, SelfInfoPatch } from "./self-info";

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

const COLUMN: Record<keyof SelfInfoPatch, keyof SelfRow> = {
  fullName: "full_name",
  bankName: "bank_name",
  bankAccountNo: "bank_account_no",
  bankAccountName: "bank_account_name",
  nickname: "nickname",
  phone: "phone",
  birthDate: "birth_date",
  address: "address",
  emergencyContactName: "emergency_contact_name",
  emergencyContactPhone: "emergency_contact_phone",
};

export async function saveMySelfInfo(scope: { organizationId: string; storeId: string; userId: string }, patch: SelfInfoPatch) {
  const supabase = await createSupabaseServerClient();
  const values: Record<string, string | null> = {};
  for (const key of Object.keys(patch) as (keyof SelfInfoPatch)[]) {
    if (patch[key] !== undefined) values[COLUMN[key]] = patch[key] ?? null;
  }
  const { error } = await supabase.from("employee_self_info").upsert(
    { organization_id: scope.organizationId, store_id: scope.storeId, user_id: scope.userId, ...values },
    { onConflict: "store_id,user_id" },
  );
  return { error: error ? mapError(error).userMessage : null };
}
