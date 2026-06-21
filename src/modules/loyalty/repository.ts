import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { Database } from "@/server/integrations/supabase/database.types";
import { mapError } from "@/shared/utils/error";

type LoyaltyAccountRow = Database["public"]["Tables"]["loyalty_accounts"]["Row"];

export interface LoyaltyAccountSummary {
  id: string;
  organizationId: string;
  storeId: string;
  customerId: string;
  pointsBalance: number;
}

function mapLoyaltyAccount(row: LoyaltyAccountRow): LoyaltyAccountSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    customerId: row.customer_id,
    pointsBalance: row.points_balance,
  };
}

export async function getLoyaltyAccountForCustomer(
  storeId: string,
  organizationId: string,
  customerId: string,
  options: { createIfMissing?: boolean } = {},
) {
  const supabase = await createSupabaseServerClient();
  const existing = await supabase
    .from("loyalty_accounts")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (existing.error) return { data: null, error: mapError(existing.error) };
  if (existing.data) return { data: mapLoyaltyAccount(existing.data), error: null };
  if (!options.createIfMissing) return { data: null, error: null };

  const created = await supabase
    .from("loyalty_accounts")
    .upsert(
      {
        organization_id: organizationId,
        store_id: storeId,
        customer_id: customerId,
      },
      { onConflict: "store_id,customer_id" },
    )
    .select("*")
    .single();

  if (created.error) return { data: null, error: mapError(created.error) };
  return { data: mapLoyaltyAccount(created.data), error: null };
}
