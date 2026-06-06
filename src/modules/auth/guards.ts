import { redirect } from "next/navigation";
import type { Role, PermissionKey, ResolvedPermissions } from "@/modules/tenants/types";
import {
  getCurrentUser,
  getUserStores,
  pickMembershipForStore,
  resolveCurrentStore,
} from "@/modules/auth/session";
import { resolvePermissions } from "@/modules/auth/permission-resolver";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE, explainFeatureLock, type FeatureKey } from "@/modules/billing/types";
import { isOrganizationSuspended } from "@/modules/system/repository";

const ROLE_RANK: Record<Role, number> = {
  super_admin: 6,
  owner: 5,
  admin: 4,
  manager: 3,
  cashier: 2,
  staff: 1,
};

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export async function getResolvedCurrentPermissions(): Promise<{
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  ctx: NonNullable<Awaited<ReturnType<typeof resolveCurrentStore>>>;
  resolved: ResolvedPermissions;
}> {
  const permissions = await getOptionalResolvedCurrentPermissions();
  if (!permissions) redirect("/login");
  return permissions;
}

export async function getOptionalResolvedCurrentPermissions(): Promise<{
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
  ctx: NonNullable<Awaited<ReturnType<typeof resolveCurrentStore>>>;
  resolved: ResolvedPermissions;
} | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);

  if (!ctx) throw new AuthorizationError("No store access");

  const membership = pickMembershipForStore(memberships, {
    userId: user.id,
    organizationId: ctx.organizationId,
    storeId: ctx.storeId,
  });
  if (!membership) throw new AuthorizationError("No membership found");

  const supabase = await createSupabaseServerClient();
  const { data: rawOverrides, error: overridesError } = await supabase
    .from("membership_permission_overrides")
    .select("permission_key, granted")
    .eq("membership_id", membership.id);
  if (overridesError) {
    throw new AuthorizationError("Unable to resolve permissions");
  }

  const overrides = (rawOverrides ?? []).map((o) => ({
    permissionKey: o.permission_key as PermissionKey,
    granted: o.granted,
  }));

  // Platform-suspended tenants block all members except super_admin.
  if (ctx.role !== "super_admin" && (await isOrganizationSuspended(ctx.organizationId))) {
    redirect("/suspended");
  }

  return {
    user,
    ctx,
    resolved: resolvePermissions(ctx.role, overrides, ctx.organizationId, ctx.storeId),
  };
}

/**
 * Ensures the calling user holds at least `minimumRole` in their current store.
 * Redirects to /login if unauthenticated; throws AuthorizationError if role is insufficient.
 * Call at the top of route handlers and server actions that require a minimum role.
 */
export async function requireRole(minimumRole: Role): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);

  if (!ctx) throw new AuthorizationError("No store access");

  if (ROLE_RANK[ctx.role] < ROLE_RANK[minimumRole]) {
    throw new AuthorizationError(`Requires role: ${minimumRole}`);
  }
}

/**
 * Ensures the calling user has the given permission key in their current store.
 * Applies role defaults + per-user overrides from membership_permission_overrides.
 * Redirects to /login if unauthenticated; throws AuthorizationError if permission is missing.
 * Call at the top of sensitive server actions (refund, delete bill, settings update, etc.).
 */
export async function requirePermission(key: PermissionKey): Promise<void> {
  const { resolved } = await getResolvedCurrentPermissions();

  if (!resolved.can(key)) {
    throw new AuthorizationError(`Missing permission: ${key}`);
  }
}

/**
 * Returns true if the current user holds a super_admin membership in any organization.
 * Platform-level access is intentionally decoupled from the per-store context used by
 * the rest of the app, because a platform operator may have no store membership.
 */
export async function isSystemAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "super_admin")
    .not("joined_at", "is", null)
    .limit(1);
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

/**
 * Guards platform console routes (/system). Redirects to /login if unauthenticated,
 * throws AuthorizationError if the user is not a super_admin.
 */
export async function requireSystemAccess(): Promise<
  NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>
> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!(await isSystemAdmin())) {
    throw new AuthorizationError("Requires platform administrator access");
  }
  return user;
}

export async function requireFeature(feature: FeatureKey): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships, user.id);
  if (!ctx) throw new AuthorizationError("No store access");

  const state =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;

  if (!canUseFeature(state, feature)) {
    throw new AuthorizationError(
      explainFeatureLock(state, feature) ?? `Feature unavailable: ${feature}`,
    );
  }
}
