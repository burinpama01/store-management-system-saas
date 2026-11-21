/**
 * เอกสารภาษี — Supabase queries (client ของผู้ใช้ → RLS)
 * store_tax_profiles: อ่าน=สมาชิกร้าน แก้=owner/admin · tax_parties: แคชเชียร์ขึ้นไป · document_sequences: อ่าน manager
 */
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { DocumentSequence, DocumentType, StoreTaxProfile, StoreTaxProfileInput, TaxParty, TaxPartyInput } from "./types";

// ตาราง/RPC ใหม่ยังไม่อยู่ใน database.types (แบบเดียวกับ missions/repository.ts)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

type Result<T> = { data: T; error: null } | { data: null; error: string };

interface StoreScope {
  organizationId: string;
  storeId: string;
}

export function taxErrorMessage(raw: string | undefined | null): string {
  const message = raw ?? "";
  if (message.includes("row-level security") || message.includes("permission denied")) return "ไม่มีสิทธิ์แก้ข้อมูลภาษี (เฉพาะเจ้าของหรือแอดมิน)";
  if (message.includes("tax_parties_store_tax_branch_unique_idx") || message.includes("duplicate key")) return "มีผู้ซื้อเลขผู้เสียภาษีและสาขานี้อยู่แล้ว";
  if (message.includes("customer must belong")) return "สมาชิกต้องอยู่ในร้านเดียวกัน";
  if (message.includes("check constraint")) return "ข้อมูลไม่ถูกต้องตามรูปแบบ";
  return "บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
}

/* eslint-disable @typescript-eslint/no-explicit-any -- แถวดิบจาก PostgREST */
function mapProfile(row: any): StoreTaxProfile {
  return {
    storeId: row.store_id,
    legalName: row.legal_name,
    taxId: row.tax_id,
    branchCode: row.branch_code,
    address: row.address,
    vatRegistered: row.vat_registered === true,
    vatRegisteredAt: row.vat_registered_at ?? null,
    posApprovalNo: row.pos_approval_no ?? null,
    pricesIncludeVat: row.prices_include_vat !== false,
    vatRate: Number(row.vat_rate ?? 7),
    updatedAt: row.updated_at,
  };
}

function mapParty(row: any): TaxParty {
  return {
    id: row.id,
    partyType: row.party_type,
    name: row.name,
    taxId: row.tax_id ?? null,
    branchCode: row.branch_code ?? null,
    address: row.address ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    customerId: row.customer_id ?? null,
    isActive: row.is_active === true,
  };
}

export async function getStoreTaxProfile(storeId: string): Promise<Result<StoreTaxProfile | null>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db.from("store_tax_profiles").select("*").eq("store_id", storeId).maybeSingle();
  if (error) return { data: null, error: taxErrorMessage(error.message) };
  return { data: data ? mapProfile(data) : null, error: null };
}

export async function saveStoreTaxProfile(scope: StoreScope, input: StoreTaxProfileInput, userId: string): Promise<Result<true>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("store_tax_profiles")
    .upsert(
      {
        store_id: scope.storeId,
        organization_id: scope.organizationId,
        legal_name: input.legalName,
        tax_id: input.taxId,
        branch_code: input.branchCode,
        address: input.address,
        vat_registered: input.vatRegistered,
        vat_registered_at: input.vatRegisteredAt,
        pos_approval_no: input.posApprovalNo,
        prices_include_vat: input.pricesIncludeVat,
        vat_rate: input.vatRate,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id" },
    )
    .select("store_id");
  if (error) return { data: null, error: taxErrorMessage(error.message) };
  if (!data || data.length === 0) return { data: null, error: "ไม่มีสิทธิ์แก้ข้อมูลภาษี (เฉพาะเจ้าของหรือแอดมิน)" };
  return { data: true, error: null };
}

export async function listDocumentSequences(storeId: string): Promise<Result<DocumentSequence[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  const { data, error } = await db
    .from("document_sequences")
    .select("doc_type, period, prefix, next_no")
    .eq("store_id", storeId)
    .order("period", { ascending: false })
    .limit(60);
  if (error) return { data: null, error: taxErrorMessage(error.message) };
  return {
    data: (data ?? []).map((row: any) => ({
      docType: row.doc_type as DocumentType,
      period: row.period,
      prefix: row.prefix,
      lastIssuedNo: Number(row.next_no) - 1,
    })),
    error: null,
  };
}

export async function searchTaxParties(storeId: string, query: string, limit = 20): Promise<Result<TaxParty[]>> {
  const db: LooseClient = await createSupabaseServerClient();
  let request = db.from("tax_parties").select("*").eq("store_id", storeId).eq("is_active", true).order("name").limit(Math.min(Math.max(limit, 1), 50));
  // ตัด wildcard ของ LIKE (% _) และอักขระที่ PostgREST ใช้แยกเงื่อนไข
  const q = query.trim().replace(/[%_,()\\]/g, "");
  if (q) request = /^\d+$/.test(q) ? request.like("tax_id", `${q}%`) : request.ilike("name", `%${q}%`);
  const { data, error } = await request;
  if (error) return { data: null, error: taxErrorMessage(error.message) };
  return { data: (data ?? []).map(mapParty), error: null };
}

export async function saveTaxParty(scope: StoreScope, input: TaxPartyInput, userId: string): Promise<Result<{ id: string }>> {
  const db: LooseClient = await createSupabaseServerClient();
  const payload = {
    organization_id: scope.organizationId,
    store_id: scope.storeId,
    party_type: input.partyType,
    name: input.name,
    tax_id: input.taxId,
    branch_code: input.branchCode,
    address: input.address,
    email: input.email,
    phone: input.phone,
    customer_id: input.customerId,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };
  const result = input.id
    ? await db.from("tax_parties").update(payload).eq("id", input.id).eq("store_id", scope.storeId).select("id").maybeSingle()
    : await db.from("tax_parties").insert({ ...payload, created_by: userId }).select("id").single();
  if (result.error) return { data: null, error: taxErrorMessage(result.error.message) };
  if (!result.data) return { data: null, error: "ไม่พบผู้ซื้อนี้" };
  return { data: { id: result.data.id }, error: null };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
