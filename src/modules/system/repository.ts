import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { BillingPlan, BillingStatus } from "@/modules/billing/types";

export interface TenantOverview {
  organizationId: string;
  name: string;
  slug: string;
  ownerId: string;
  plan: BillingPlan;
  status: BillingStatus;
  storeCount: number;
  memberCount: number;
  createdAt: string;
}

export interface PlatformSummary {
  totalTenants: number;
  totalStores: number;
  totalMembers: number;
  byPlan: Record<BillingPlan, number>;
  trialingCount: number;
  pastDueCount: number;
}

/**
 * Cross-tenant platform view. Uses the service client and MUST only be reached
 * after requireSystemAccess() has confirmed the caller is a super_admin.
 */
export async function listTenantOverview(): Promise<TenantOverview[]> {
  const supabase = await createSupabaseServiceClient();

  const [orgsRes, subsRes, storesRes, membersRes] = await Promise.all([
    supabase.from("organizations").select("id, name, slug, owner_id, created_at").order("created_at", { ascending: false }),
    supabase.from("subscriptions").select("organization_id, plan, status"),
    supabase.from("stores").select("organization_id, is_active"),
    supabase.from("memberships").select("organization_id, joined_at"),
  ]);

  const subsByOrg = new Map<string, { plan: BillingPlan; status: BillingStatus }>();
  for (const s of subsRes.data ?? []) {
    subsByOrg.set(s.organization_id, { plan: s.plan as BillingPlan, status: s.status as BillingStatus });
  }

  const storeCountByOrg = new Map<string, number>();
  for (const s of storesRes.data ?? []) {
    if (s.is_active === false) continue;
    storeCountByOrg.set(s.organization_id, (storeCountByOrg.get(s.organization_id) ?? 0) + 1);
  }

  const memberCountByOrg = new Map<string, number>();
  for (const m of membersRes.data ?? []) {
    if (!m.joined_at) continue;
    memberCountByOrg.set(m.organization_id, (memberCountByOrg.get(m.organization_id) ?? 0) + 1);
  }

  return (orgsRes.data ?? []).map((org) => {
    const sub = subsByOrg.get(org.id);
    return {
      organizationId: org.id,
      name: org.name,
      slug: org.slug,
      ownerId: org.owner_id,
      plan: sub?.plan ?? "free",
      status: sub?.status ?? "active",
      storeCount: storeCountByOrg.get(org.id) ?? 0,
      memberCount: memberCountByOrg.get(org.id) ?? 0,
      createdAt: org.created_at,
    };
  });
}

export function summarizeTenants(tenants: TenantOverview[]): PlatformSummary {
  const byPlan: Record<BillingPlan, number> = {
    free: 0,
    starter: 0,
    standard: 0,
    premium: 0,
    enterprise: 0,
  };
  let totalStores = 0;
  let totalMembers = 0;
  let trialingCount = 0;
  let pastDueCount = 0;

  for (const t of tenants) {
    byPlan[t.plan] = (byPlan[t.plan] ?? 0) + 1;
    totalStores += t.storeCount;
    totalMembers += t.memberCount;
    if (t.status === "trialing") trialingCount += 1;
    if (t.status === "past_due" || t.status === "unpaid") pastDueCount += 1;
  }

  return {
    totalTenants: tenants.length,
    totalStores,
    totalMembers,
    byPlan,
    trialingCount,
    pastDueCount,
  };
}
