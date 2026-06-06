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

export interface TenantStore {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface TenantMember {
  userId: string;
  email: string | null;
  role: string;
  storeId: string | null;
  joinedAt: string | null;
}

export interface TenantSubscription {
  plan: BillingPlan;
  status: BillingStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: string | null;
}

export interface TenantDetail {
  organizationId: string;
  name: string;
  slug: string;
  ownerId: string;
  ownerEmail: string | null;
  createdAt: string;
  subscription: TenantSubscription | null;
  stores: TenantStore[];
  members: TenantMember[];
}

export interface AuditLogEntry {
  id: string;
  organizationId: string;
  storeId: string | null;
  actorUserId: string;
  targetUserId: string | null;
  action: string;
  reason: string | null;
  createdAt: string;
}

/**
 * Full read-only detail for one tenant. Service-client only; reach only after
 * requireSystemAccess(). Returns null when the organization does not exist.
 */
export async function getTenantDetail(organizationId: string): Promise<TenantDetail | null> {
  const supabase = await createSupabaseServiceClient();

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, slug, owner_id, created_at")
    .eq("id", organizationId)
    .maybeSingle();
  if (!org) return null;

  const [subRes, storesRes, membersRes] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("plan, status, current_period_end, cancel_at_period_end, trial_end")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    supabase
      .from("stores")
      .select("id, name, slug, is_active")
      .eq("organization_id", organizationId)
      .order("name"),
    supabase
      .from("memberships")
      .select("user_id, role, store_id, joined_at")
      .eq("organization_id", organizationId),
  ]);

  const members: TenantMember[] = await Promise.all(
    (membersRes.data ?? []).map(async (m) => {
      let email: string | null = null;
      try {
        const { data } = await supabase.auth.admin.getUserById(m.user_id);
        email = data.user?.email ?? null;
      } catch {
        email = null;
      }
      return {
        userId: m.user_id,
        email,
        role: m.role,
        storeId: m.store_id,
        joinedAt: m.joined_at ?? null,
      };
    }),
  );

  const ownerEmail = members.find((m) => m.userId === org.owner_id)?.email ?? null;

  return {
    organizationId: org.id,
    name: org.name,
    slug: org.slug,
    ownerId: org.owner_id,
    ownerEmail,
    createdAt: org.created_at,
    subscription: subRes.data
      ? {
          plan: subRes.data.plan as BillingPlan,
          status: subRes.data.status as BillingStatus,
          currentPeriodEnd: subRes.data.current_period_end,
          cancelAtPeriodEnd: subRes.data.cancel_at_period_end,
          trialEnd: subRes.data.trial_end,
        }
      : null,
    stores: (storesRes.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      isActive: s.is_active,
    })),
    members,
  };
}

/**
 * Recent audit log entries across all tenants (platform security view).
 * Service-client only; reach only after requireSystemAccess().
 */
export async function listRecentAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("audit_logs")
    .select("id, organization_id, store_id, actor_user_id, target_user_id, action, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    storeId: row.store_id,
    actorUserId: row.actor_user_id,
    targetUserId: row.target_user_id,
    action: row.action,
    reason: row.reason,
    createdAt: row.created_at,
  }));
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
