import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { Database } from "@/server/integrations/supabase/database.types";
import type { CustomerProfile } from "./types";

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
    loyaltyAccountId: loyaltyAccount?.id,
    pointsBalance: loyaltyAccount?.points_balance,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function searchCustomersForStore(storeId: string, query: string, limit = 10) {
  const normalized = normalizeCustomerQuery(query);
  if (!normalized) return { data: [], error: null };

  const supabase = await createSupabaseServerClient();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 25);
  const escaped = normalized.replace(/\*/g, "");
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .or(`name.ilike.%${escaped}%,phone.ilike.%${escaped}%,email.ilike.%${escaped}%`)
    .order("updated_at", { ascending: false })
    .limit(safeLimit);

  if (error) return { data: null, error: mapError(error) };
  const customers = data ?? [];
  if (customers.length === 0) return { data: [], error: null };

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
