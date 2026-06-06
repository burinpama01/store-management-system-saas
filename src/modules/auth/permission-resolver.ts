import type {
  PermissionKey,
  Role,
  ResolvedPermissions,
  MembershipPermissionOverride,
} from "@/modules/tenants/types";
import { ROLE_DEFAULT_PERMISSIONS } from "@/modules/tenants/types";

export function resolvePermissions(
  role: Role,
  overrides: Pick<MembershipPermissionOverride, "permissionKey" | "granted">[],
  organizationId: string,
  storeId: string | null
): ResolvedPermissions {
  const base = new Set<PermissionKey>(ROLE_DEFAULT_PERMISSIONS[role]);

  for (const override of overrides) {
    if (override.granted) {
      base.add(override.permissionKey);
    } else {
      base.delete(override.permissionKey);
    }
  }

  return {
    organizationId,
    storeId,
    role,
    permissions: base,
    can: (key: PermissionKey) => base.has(key),
  };
}

export interface PermissionMutationInput {
  actorUserId: string;
  actorPermissions: ResolvedPermissions;
  targetMembershipId: string;
  targetUserId: string;
  targetRole: Role;
  targetOrganizationId: string;
  targetStoreId: string | null;
  permissionKey: PermissionKey;
  granted: boolean;
  reason: string;
}

export type PermissionMutationError =
  | "self_edit"
  | "cross_tenant"
  | "super_admin_only"
  | "owner_only"
  | "actor_lacks_permissions_manage"
  | "escalation_denied";

export function validatePermissionMutation(
  input: PermissionMutationInput
): { ok: true } | { ok: false; error: PermissionMutationError } {
  const {
    actorUserId,
    actorPermissions,
    targetUserId,
    targetOrganizationId,
    targetRole,
    permissionKey,
    granted,
  } = input;

  // Actor cannot modify their own permissions
  if (actorUserId === targetUserId) {
    return { ok: false, error: "self_edit" };
  }

  // Actor must be in the same org (deny cross-tenant)
  if (actorPermissions.organizationId !== targetOrganizationId) {
    return { ok: false, error: "cross_tenant" };
  }

  const isSuperAdmin = actorPermissions.role === "super_admin";

  // Only super_admin can modify super_admin members or platform-only permission keys.
  const platformOnlyKeys: PermissionKey[] = ["organizations.manage", "system.manage"];
  if (targetRole === "super_admin" && !isSuperAdmin) {
    return { ok: false, error: "super_admin_only" };
  }
  if (platformOnlyKeys.includes(permissionKey) && !isSuperAdmin) {
    return { ok: false, error: "super_admin_only" };
  }

  // Only owner or super_admin can modify owner-role members or grant owner-only permission keys.
  // Checked before permissions.manage so the error reflects the true constraint.
  const ownerOnlyKeys: PermissionKey[] = ["permissions.manage"];
  if (targetRole === "owner" && actorPermissions.role !== "owner" && !isSuperAdmin) {
    return { ok: false, error: "owner_only" };
  }
  if (ownerOnlyKeys.includes(permissionKey) && actorPermissions.role !== "owner" && !isSuperAdmin) {
    return { ok: false, error: "owner_only" };
  }

  // Actor must hold permissions.manage to mutate any permission
  if (!actorPermissions.can("permissions.manage")) {
    return { ok: false, error: "actor_lacks_permissions_manage" };
  }

  // Actor cannot grant a permission they do not themselves have (no escalation)
  if (granted && !actorPermissions.can(permissionKey)) {
    return { ok: false, error: "escalation_denied" };
  }

  return { ok: true };
}
