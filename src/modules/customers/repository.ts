import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import { normalizePriceTier } from "@/modules/pos/pricing";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { CustomerProfile, CustomerSaveInput } from "./types";
import { normalizeCustomerPhoneOrNull } from "@/shared/utils/customer-phone";
import { escapeLikePattern } from "@/shared/utils/like-pattern";

type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];
type LoyaltyAccountRow = Pick<
  Database["public"]["Tables"]["loyalty_accounts"]["Row"],
  "id" | "customer_id" | "points_balance"
>;

function normalizeCustomerQuery(query: string): string {
  return query.trim().replace(/[%,()]/g, " ").replace(/\s+/g, " ");
}

function mapCustomer(row: CustomerRow, loyaltyAccount?: LoyaltyAccountRow): CustomerProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    name: row.name,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    priceTier: normalizePriceTier(row.price_tier),
    loyaltyAccountId: loyaltyAccount?.id,
    pointsBalance: loyaltyAccount?.points_balance,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function mapCustomersWithLoyaltyAccounts(storeId: string, customers: CustomerRow[]) {
  if (customers.length === 0) return { data: [], error: null };

  const supabase = await createSupabaseServerClient();
  const accountsRes = await supabase
    .from("loyalty_accounts")
    .select("id, customer_id, points_balance")
    .eq("store_id", storeId)
    .in("customer_id", customers.map((customer) => customer.id));
  if (accountsRes.error) return { data: null, error: mapError(accountsRes.error) };

  const accountsByCustomer = new Map(
    (accountsRes.data ?? []).map((account) => [account.customer_id, account]),
  );
  return { data: customers.map((customer) => mapCustomer(customer, accountsByCustomer.get(customer.id))), error: null };
}

/**
 * รายชื่อลูกค้าของร้าน — รองรับค้นหาฝั่งเซิร์ฟเวอร์และบอกจำนวนทั้งหมด
 *
 * เดิมคืนแค่ 100 รายแรกโดยไม่บอกว่าถูกตัด (audit ข้อ 6) ร้านที่มีลูกค้าเกิน 100
 * จึงหาคนที่ 101 ไม่เจอเลยและไม่รู้ตัวด้วย — ตอนนี้ค้นได้ทั้งฐานและเห็น total เสมอ
 */
export async function listCustomersForStore(
  storeId: string,
  options: { includeInactive?: boolean; limit?: number; search?: string } = {},
) {
  const supabase = await createSupabaseServerClient();
  const safeLimit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 250);
  const search = normalizeCustomerQuery(options.search ?? "");

  let query = supabase
    .from("customers")
    .select("*", { count: "exact" })
    .eq("store_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(safeLimit);

  if (!options.includeInactive) query = query.eq("is_active", true);
  if (search) {
    // ค้นทั้งฐาน ไม่ใช่กรองเฉพาะ 100 แถวที่โหลดมา — escape กัน _ และ % กลายเป็น wildcard
    const pattern = escapeLikePattern(search);
    query = query.or(`name.ilike.%${pattern}%,phone.ilike.%${pattern}%,email.ilike.%${pattern}%`);
  }

  const { data, error, count } = await query;
  if (error) return { data: null, error: mapError(error), total: 0, truncated: false };

  const mapped = await mapCustomersWithLoyaltyAccounts(storeId, data ?? []);
  const total = count ?? mapped.data?.length ?? 0;
  return { ...mapped, total, truncated: total > (data?.length ?? 0) };
}

export async function searchCustomersForStore(storeId: string, query: string, limit = 10) {
  const normalized = normalizeCustomerQuery(query);
  if (!normalized) return { data: [], error: null };

  const supabase = await createSupabaseServerClient();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 25);
  // escape ให้ครบ: เดิมตัดแค่ * ทำให้ _ และ % ในคำค้นกลายเป็น wildcard จับคนผิด (audit ข้อ 9)
  const escaped = escapeLikePattern(normalized.replace(/\*/g, ""));
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .or(`name.ilike.%${escaped}%,phone.ilike.%${escaped}%,email.ilike.%${escaped}%`)
    .order("updated_at", { ascending: false })
    .limit(safeLimit);

  if (error) return { data: null, error: mapError(error) };
  return mapCustomersWithLoyaltyAccounts(storeId, data ?? []);
}

export async function getCustomerById(storeId: string, customerId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("store_id", storeId)
    .eq("id", customerId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapCustomer(data) : null, error: null };
}

export async function saveCustomer(input: CustomerSaveInput) {
  const supabase = await createSupabaseServerClient();
  const payload = {
    organization_id: input.organizationId,
    store_id: input.storeId,
    name: input.name.trim(),
    // normalize ให้เป็นรูปแบบเดียวกับที่ member portal ใช้ค้นหา (audit ข้อ 2)
    phone: normalizeCustomerPhoneOrNull(input.phone),
    email: input.email?.trim() || null,
    // Only touch the tier when explicitly provided so older callers keep the saved tier.
    ...(input.priceTier !== undefined ? { price_tier: normalizePriceTier(input.priceTier) } : {}),
    is_active: input.isActive ?? true,
    updated_at: new Date().toISOString(),
  };

  const result = input.id
    ? await supabase
        .from("customers")
        .update(payload)
        .eq("id", input.id)
        .eq("store_id", input.storeId)
        .select("*")
        .single()
    : await supabase
        .from("customers")
        .insert(payload)
        .select("*")
        .single();

  if (result.error) {
    // unique (store_id, phone) — บอกให้ชัดว่าเบอร์ซ้ำ ไม่ใช่ข้อความ generic
    if (result.error.code === "23505") {
      return {
        data: null,
        error: {
          code: "customer_phone_taken",
          message: "duplicate customer phone",
          userMessage: "เบอร์นี้มีลูกค้าอยู่แล้วในร้าน — ค้นหาชื่อเดิมแล้วแก้ไขแทนการสร้างใหม่",
        },
      };
    }
    return { data: null, error: mapError(result.error) };
  }

  return { data: mapCustomer(result.data), error: null };
}

export async function deleteCustomer(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("customers")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id")
    .single();
  if (error) return { error: mapError(error) };
  return { error: null };
}
