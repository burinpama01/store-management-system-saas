import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import type { BillingPlan, BillingStatus } from "@/modules/billing/types";

const ENTERPRISE_PERIOD_END = "2099-12-31T23:59:59Z";

export interface TenantOverview {
  organizationId: string;
  name: string;
  slug: string;
  ownerId: string;
  plan: BillingPlan;
  status: BillingStatus;
  storeCount: number;
  memberCount: number;
  suspended: boolean;
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
    supabase.from("organizations").select("id, name, slug, owner_id, suspended_at, created_at").order("created_at", { ascending: false }),
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
      suspended: Boolean(org.suspended_at),
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
  suspended: boolean;
  createdAt: string;
  subscription: TenantSubscription | null;
  stores: TenantStore[];
  members: TenantMember[];
}

export interface TenantPaymentRow {
  plan: string;
  duration: string;
  amountExpected: number;
  verifiedAmount: number | null;
  status: string;
  slipRef: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

/** Billing/slip history for a tenant (platform view). Service-client only. */
export async function listTenantPayments(organizationId: string): Promise<TenantPaymentRow[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("payment_submissions")
    .select("plan, duration, amount_expected, verified_amount, status, slip_ref, created_at, verified_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(50);
  return (data ?? []).map((p) => ({
    plan: p.plan,
    duration: p.duration,
    amountExpected: Number(p.amount_expected ?? 0),
    verifiedAmount: p.verified_amount == null ? null : Number(p.verified_amount),
    status: p.status,
    slipRef: p.slip_ref,
    createdAt: p.created_at,
    verifiedAt: p.verified_at,
  }));
}

/**
 * Platform override: set a tenant's plan directly (no payment). Service-client
 * only; caller MUST be a verified super_admin. Writes an audit log entry.
 */
export async function setTenantPlan(input: {
  organizationId: string;
  plan: BillingPlan;
  actorUserId: string;
}): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const enterprisePeriodEnd = input.plan === "enterprise" ? ENTERPRISE_PERIOD_END : null;
  const nextPeriodEnd = enterprisePeriodEnd ?? new Date(Date.now() + 30 * 86_400_000).toISOString();

  const { data: existing } = await supabase
    .from("subscriptions")
    .select("current_period_end")
    .eq("organization_id", input.organizationId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("subscriptions")
      .update({
        plan: input.plan,
        status: "active",
        cancel_at_period_end: false,
        current_period_start: now,
        current_period_end: nextPeriodEnd,
        updated_at: now,
      })
      .eq("organization_id", input.organizationId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from("subscriptions").upsert(
      {
        organization_id: input.organizationId,
        plan: input.plan,
        status: "active",
        current_period_start: now,
        current_period_end: nextPeriodEnd,
        cancel_at_period_end: false,
        updated_at: now,
      },
      { onConflict: "organization_id" },
    );
    if (error) return { ok: false, error: error.message };
  }

  await supabase.from("audit_logs").insert({
    organization_id: input.organizationId,
    store_id: null,
    actor_user_id: input.actorUserId,
    target_user_id: null,
    action: "tenant.plan_change",
    reason: `plan → ${input.plan} (platform override)`,
  });

  return { ok: true, error: null };
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
    .select("id, name, slug, owner_id, suspended_at, created_at")
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
    suspended: Boolean(org.suspended_at),
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

export interface TenantOperations {
  productCount: number;
  orderCount: number;
  paidCount: number;
  salesTotal: number;
  recentOrders: Array<{
    orderNumber: string;
    status: string;
    total: number;
    paid: boolean;
    createdAt: string;
  }>;
}

/**
 * Read-only operational snapshot of a tenant for the platform console.
 * Service-client only; reach only after requireSystemAccess(). Super admin can
 * view but not act on tenant data.
 */
export async function getTenantOperations(organizationId: string): Promise<TenantOperations> {
  const supabase = await createSupabaseServiceClient();

  const [{ count: productCount }, ordersRes] = await Promise.all([
    supabase
      .from("products")
      .select("id", { head: true, count: "exact" })
      .eq("organization_id", organizationId),
    supabase
      .from("orders")
      .select("order_number, status, total, paid_at, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const orders = ordersRes.data ?? [];
  let salesTotal = 0;
  let paidCount = 0;
  for (const o of orders) {
    if (o.paid_at) {
      paidCount += 1;
      salesTotal += Number(o.total ?? 0);
    }
  }

  return {
    productCount: productCount ?? 0,
    orderCount: orders.length,
    paidCount,
    salesTotal,
    recentOrders: orders.slice(0, 8).map((o) => ({
      orderNumber: o.order_number,
      status: o.status,
      total: Number(o.total ?? 0),
      paid: Boolean(o.paid_at),
      createdAt: o.created_at,
    })),
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

export interface TenantSuspensionPlan {
  suspendedAt: string | null;
  subscriptionStatus: BillingStatus | null;
  auditAction: "tenant.suspend" | "tenant.unsuspend";
}

/**
 * Pure: derives the desired DB state for a suspend/unsuspend operation.
 * Suspending blocks login (suspended_at) AND cancels the subscription;
 * unsuspending clears the block but does not auto-restore a prior plan.
 */
export function planTenantSuspension(
  suspend: boolean,
  now: string,
): TenantSuspensionPlan {
  return suspend
    ? { suspendedAt: now, subscriptionStatus: "canceled", auditAction: "tenant.suspend" }
    : { suspendedAt: null, subscriptionStatus: null, auditAction: "tenant.unsuspend" };
}

export interface SetTenantSuspensionResult {
  ok: boolean;
  error: string | null;
}

/**
 * Platform action: suspend or resume a tenant. Service-client only; the caller
 * MUST be a verified super_admin (enforce with requireSystemAccess before calling).
 * Writes an append-only audit log entry for the action.
 */
export async function setTenantSuspension(input: {
  organizationId: string;
  suspend: boolean;
  actorUserId: string;
  reason: string;
}): Promise<SetTenantSuspensionResult> {
  const supabase = await createSupabaseServiceClient();
  const now = new Date().toISOString();
  const plan = planTenantSuspension(input.suspend, now);

  const { error: orgErr } = await supabase
    .from("organizations")
    .update({ suspended_at: plan.suspendedAt, updated_at: now })
    .eq("id", input.organizationId);
  if (orgErr) return { ok: false, error: orgErr.message };

  if (plan.subscriptionStatus) {
    // Best-effort: a tenant may have no subscription row yet.
    await supabase
      .from("subscriptions")
      .update({ status: plan.subscriptionStatus, updated_at: now })
      .eq("organization_id", input.organizationId);
  }

  const { error: auditErr } = await supabase.from("audit_logs").insert({
    organization_id: input.organizationId,
    store_id: null,
    actor_user_id: input.actorUserId,
    target_user_id: null,
    action: plan.auditAction,
    reason: input.reason || null,
  });
  if (auditErr) return { ok: false, error: auditErr.message };

  return { ok: true, error: null };
}

/**
 * Whether an organization is currently suspended. Used to gate app access for
 * non-super_admin members. Uses the user-scoped server client (members can read
 * their own org), failing closed on error.
 */
export async function isOrganizationSuspended(organizationId: string): Promise<boolean> {
  const { createSupabaseServerClient } = await import(
    "@/server/integrations/supabase/server"
  );
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("suspended_at")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.suspended_at);
}

export interface PlatformPayment {
  organizationId: string;
  orgName: string;
  plan: string;
  duration: string;
  amount: number;
  verifiedAt: string | null;
}

export interface PaymentTotals {
  total: number;
  thisMonth: number;
  count: number;
}

/** Pure: sums verified payment amounts overall and for the current month. */
export function summarizePayments(
  rows: Array<{ amount: number; verifiedAt: string | null }>,
  now: Date = new Date(),
): PaymentTotals {
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let total = 0;
  let thisMonth = 0;
  for (const r of rows) {
    total += r.amount;
    if (r.verifiedAt && r.verifiedAt.slice(0, 7) === ym) thisMonth += r.amount;
  }
  return { total, thisMonth, count: rows.length };
}

export interface PlatformDashboard {
  summary: PlatformSummary;
  totals: PaymentTotals;
  recentPayments: PlatformPayment[];
  recentTenants: TenantOverview[];
}

/**
 * Aggregated platform dashboard for super_admin. Service-client only; reach only
 * after requireSystemAccess().
 */
export async function getPlatformDashboard(): Promise<PlatformDashboard> {
  const supabase = await createSupabaseServiceClient();
  const tenants = await listTenantOverview();
  const nameById = new Map(tenants.map((t) => [t.organizationId, t.name]));

  const { data: paid } = await supabase
    .from("payment_submissions")
    .select("organization_id, plan, duration, verified_amount, verified_at")
    .eq("status", "verified")
    .order("verified_at", { ascending: false });

  const rows = (paid ?? []).map((p) => ({
    organizationId: p.organization_id,
    orgName: nameById.get(p.organization_id) ?? "—",
    plan: p.plan,
    duration: p.duration,
    amount: Number(p.verified_amount ?? 0),
    verifiedAt: p.verified_at,
  }));

  return {
    summary: summarizeTenants(tenants),
    totals: summarizePayments(rows.map((r) => ({ amount: r.amount, verifiedAt: r.verifiedAt }))),
    recentPayments: rows.slice(0, 8),
    recentTenants: tenants.slice(0, 6),
  };
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
