"use server";

import { revalidatePath } from "next/cache";
import { getResolvedCurrentPermissions, requirePermission } from "@/modules/auth/guards";
import { validatePermissionMutation } from "@/modules/auth/permission-resolver";
import {
  upsertPermissionOverride,
  removePermissionOverride,
  appendAuditLog,
} from "@/modules/tenants/repository";
import { updateMemberRole, removeMember } from "@/modules/settings/repository";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type { Role, PermissionKey } from "@/modules/tenants/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canManageProtectedRole(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === "super_admin") return actorRole === "super_admin";
  if (targetRole === "owner") return actorRole === "owner" || actorRole === "super_admin";
  return true;
}

async function getActorContext() {
  return getResolvedCurrentPermissions();
}

async function loadTargetMembership(membershipId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("memberships")
    .select("id, user_id, role, organization_id, store_id")
    .eq("id", membershipId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return data;
}

export async function updateMemberRoleAction(
  membershipId: string,
  newRole: Role,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("users.manage");
    const { user, ctx, resolved } = await getActorContext();

    if (!UUID_RE.test(membershipId)) return { error: "ID ไม่ถูกต้อง" };

    const target = await loadTargetMembership(membershipId, ctx.organizationId);
    if (!target) return { error: "ไม่พบ membership" };

    if (target.user_id === user.id) return { error: "ไม่สามารถแก้ไขสิทธิ์ตัวเองได้" };
    if (!canManageProtectedRole(resolved.role, target.role as Role))
      return { error: "เฉพาะ super admin เท่านั้นที่สามารถแก้ไข role นี้ได้" };
    if (!canManageProtectedRole(resolved.role, newRole))
      return { error: "เฉพาะ super admin เท่านั้นที่สามารถมอบหมาย role นี้ได้" };

    const result = await updateMemberRole(membershipId, ctx.organizationId, newRole);
    if (result.error) return { error: result.error.userMessage };

    await appendAuditLog({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      targetUserId: target.user_id,
      action: "update_member_role",
      before: { role: target.role },
      after: { role: newRole },
      reason: null,
    });

    revalidatePath("/settings/team");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function upsertPermissionOverrideAction(
  membershipId: string,
  targetUserId: string,
  targetRole: Role,
  permissionKey: PermissionKey,
  granted: boolean,
): Promise<{ error: string | null }> {
  try {
    await requirePermission("permissions.manage");
    const { user, ctx, resolved } = await getActorContext();

    if (!UUID_RE.test(membershipId)) return { error: "ID ไม่ถูกต้อง" };

    const target = await loadTargetMembership(membershipId, ctx.organizationId);
    if (!target) return { error: "ไม่พบ membership" };

    // F05: use DB-verified values, not caller-supplied targetUserId/targetRole
    const validation = validatePermissionMutation({
      actorUserId: user.id,
      actorPermissions: resolved,
      targetMembershipId: membershipId,
      targetUserId: target.user_id,
      targetRole: target.role as Role,
      targetOrganizationId: ctx.organizationId,
      targetStoreId: target.store_id,
      permissionKey,
      granted,
      reason: "settings-ui",
    });

    if (!validation.ok) {
      const errorMessages: Record<string, string> = {
        self_edit: "ไม่สามารถแก้ไขสิทธิ์ตัวเองได้",
        cross_tenant: "ข้ามองค์กรไม่ได้",
        super_admin_only: "เฉพาะ super admin เท่านั้น",
        owner_only: "เฉพาะ owner เท่านั้น",
        role_permission_locked: "role นี้ไม่สามารถรับสิทธิ์นี้ได้",
        actor_lacks_permissions_manage: "ไม่มีสิทธิ์จัดการ permissions",
        escalation_denied: "ไม่สามารถมอบสิทธิ์ที่ตัวเองไม่มีได้",
      };
      return { error: errorMessages[validation.error] ?? "ไม่สามารถแก้ไขสิทธิ์นี้ได้" };
    }

    const result = await upsertPermissionOverride({
      membershipId,
      organizationId: ctx.organizationId,
      storeId: target.store_id,
      permissionKey,
      granted,
      reason: "settings-ui",
      grantedByUserId: user.id,
    });
    if (result.error) return { error: result.error.userMessage };

    await appendAuditLog({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      targetUserId: target.user_id,
      action: `permission_override_${granted ? "grant" : "revoke"}`,
      before: null,
      after: { permissionKey, granted },
      reason: "settings-ui",
    });

    revalidatePath("/settings/team");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function removePermissionOverrideAction(
  membershipId: string,
  _targetUserId: string,
  permissionKey: PermissionKey,
): Promise<{ error: string | null }> {
  try {
    void _targetUserId;
    await requirePermission("permissions.manage");
    const { user, ctx, resolved } = await getActorContext();

    if (!UUID_RE.test(membershipId)) return { error: "ID ไม่ถูกต้อง" };

    const target = await loadTargetMembership(membershipId, ctx.organizationId);
    if (!target) return { error: "ไม่พบ membership" };
    if (user.id === target.user_id) return { error: "ไม่สามารถแก้ไขสิทธิ์ตัวเองได้" };
    if (!canManageProtectedRole(resolved.role, target.role as Role))
      return { error: "เฉพาะ super admin เท่านั้นที่สามารถแก้ไขสิทธิ์นี้ได้" };

    const result = await removePermissionOverride(membershipId, ctx.organizationId, permissionKey);
    if (result.error) return { error: result.error.userMessage };

    await appendAuditLog({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      targetUserId: target.user_id,
      action: "permission_override_reset",
      before: { permissionKey },
      after: null,
      reason: "settings-ui",
    });

    revalidatePath("/settings/team");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function removeMemberAction(
  membershipId: string,
  _targetUserId: string,
): Promise<{ error: string | null }> {
  try {
    void _targetUserId;
    await requirePermission("users.manage");
    const { user, ctx, resolved } = await getActorContext();

    if (!UUID_RE.test(membershipId)) return { error: "ID ไม่ถูกต้อง" };

    const target = await loadTargetMembership(membershipId, ctx.organizationId);
    if (!target) return { error: "ไม่พบ membership" };
    if (user.id === target.user_id) return { error: "ไม่สามารถลบตัวเองออกได้" };
    if (!canManageProtectedRole(resolved.role, target.role as Role))
      return { error: "เฉพาะ super admin เท่านั้นที่สามารถลบ role นี้ออกได้" };

    const result = await removeMember(membershipId, ctx.organizationId);
    if (result.error) return { error: result.error.userMessage };

    await appendAuditLog({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      actorUserId: user.id,
      targetUserId: target.user_id,
      action: "remove_member",
      before: { role: target.role },
      after: null,
      reason: null,
    });

    revalidatePath("/settings/team");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
