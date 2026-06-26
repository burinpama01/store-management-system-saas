import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";

export type EnterpriseRequestStatus = "new" | "contacted" | "closed";

export interface EnterpriseRequest {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string | null;
  branchCount: number | null;
  message: string | null;
  organizationId: string | null;
  status: EnterpriseRequestStatus;
  createdAt: string;
}

export interface EnterpriseRequestInput {
  companyName: string;
  contactName: string;
  email: string;
  phone?: string | null;
  branchCount?: number | null;
  message?: string | null;
  organizationId?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure: validate a submitted Enterprise request. Returns Thai error messages. */
export function validateEnterpriseRequest(input: {
  companyName: string;
  contactName: string;
  email: string;
  phone?: string | null;
  branchCount?: number | null;
  message?: string | null;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!input.companyName.trim()) errors.push("กรุณากรอกชื่อบริษัท/องค์กร");
  if (!input.contactName.trim()) errors.push("กรุณากรอกชื่อผู้ติดต่อ");
  if (!EMAIL_RE.test(input.email.trim())) errors.push("อีเมลไม่ถูกต้อง");
  if (input.phone && input.phone.trim().length > 40) errors.push("เบอร์โทรยาวเกินไป");
  if (
    input.branchCount !== null &&
    input.branchCount !== undefined &&
    (!Number.isInteger(input.branchCount) || input.branchCount < 0 || input.branchCount > 100000)
  ) {
    errors.push("จำนวนสาขาไม่ถูกต้อง");
  }
  if (input.message && input.message.length > 2000) errors.push("ข้อความยาวเกินไป");
  return { valid: errors.length === 0, errors };
}

export async function createEnterpriseRequest(input: EnterpriseRequestInput) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("enterprise_requests").insert({
    company_name: input.companyName.trim(),
    contact_name: input.contactName.trim(),
    email: input.email.trim(),
    phone: input.phone?.trim() || null,
    branch_count: input.branchCount ?? null,
    message: input.message?.trim() || null,
    organization_id: input.organizationId ?? null,
  });
  if (error) return { ok: false as const, error: mapError(error) };
  return { ok: true as const, error: null };
}

function mapRequest(row: {
  id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string | null;
  branch_count: number | null;
  message: string | null;
  organization_id: string | null;
  status: EnterpriseRequestStatus;
  created_at: string;
}): EnterpriseRequest {
  return {
    id: row.id,
    companyName: row.company_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    branchCount: row.branch_count,
    message: row.message,
    organizationId: row.organization_id,
    status: row.status,
    createdAt: row.created_at,
  };
}

const REQUEST_COLUMNS =
  "id, company_name, contact_name, email, phone, branch_count, message, organization_id, status, created_at";

export async function listEnterpriseRequests(): Promise<EnterpriseRequest[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("enterprise_requests")
    .select(REQUEST_COLUMNS)
    .order("created_at", { ascending: false });
  return (data ?? []).map(mapRequest);
}

export async function updateEnterpriseRequestStatus(id: string, status: EnterpriseRequestStatus) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("enterprise_requests")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false as const, error: mapError(error) };
  return { ok: true as const, error: null };
}
