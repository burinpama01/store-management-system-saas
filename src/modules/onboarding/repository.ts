// Onboarding readiness repository (F1/Task 5+6) — real count snapshots.
// Every query is user-scoped (RLS) AND explicitly scoped by organization_id +
// store_id derived from the permission resolver by the caller.
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { ReadinessSnapshot } from "./readiness";

/**
 * profileComplete: name + address + phone are all filled (the fields the old
 * onboarding step 1 asked for). Deterministic, no AI.
 */
function deriveProfileComplete(store: { name: string | null; address: string | null; phone: string | null }): boolean {
  return Boolean(store.name?.trim() && store.address?.trim() && store.phone?.trim());
}

export async function getReadinessSnapshot(
  storeId: string,
  organizationId: string,
): Promise<{ data: ReadinessSnapshot | null; error: string | null }> {
  const supabase = await createSupabaseServerClient();

  const storeRes = await supabase
    .from("stores")
    .select("name, address, phone")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (storeRes.error) return { data: null, error: storeRes.error.message };
  const store = storeRes.data as { name: string | null; address: string | null; phone: string | null } | null;
  if (!store) return { data: null, error: "store_not_found" };

  const countRows = async (
    table: "products" | "tables" | "printers" | "customers" | "orders",
    extra?: Record<string, string>,
  ): Promise<number> => {
    let query = supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("organization_id", organizationId);
    if (extra) {
      for (const [column, value] of Object.entries(extra)) query = query.eq(column, value);
    }
    const res = await query;
    if (res.error) throw new Error(res.error.message);
    return res.count ?? 0;
  };

  try {
    const [products, tables, printers, members, paidOrders] = await Promise.all([
      countRows("products"),
      countRows("tables"),
      countRows("printers"),
      countRows("customers"),
      countRows("orders", { status: "paid" }),
    ]);
    const data: ReadinessSnapshot = {
      profileComplete: deriveProfileComplete(store),
      products,
      tables,
      printers,
      members,
      paidOrders,
    };
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : "query_failed" };
  }
}