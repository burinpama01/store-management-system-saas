import { describe, it, expect } from "vitest";
import { resolvePermissions, validatePermissionMutation } from "@/modules/auth/permission-resolver";
import type { ResolvedPermissions } from "@/modules/tenants/types";

const ORG = "org-1";
const STORE = "store-1";
const ACTOR_ID = "user-actor";
const TARGET_ID = "user-target";

function makeActor(role: "super_admin" | "owner" | "admin" | "manager" | "cashier" | "staff", overrides: { key: string; granted: boolean }[] = []): ResolvedPermissions {
  return resolvePermissions(role, overrides.map(o => ({ permissionKey: o.key as never, granted: o.granted })), ORG, STORE);
}

describe("resolvePermissions", () => {
  it("owner has permissions.manage", () => {
    const p = makeActor("owner");
    expect(p.can("permissions.manage")).toBe(true);
  });

  it("owner can manage billing but not platform administration", () => {
    const p = makeActor("owner");
    expect(p.can("billing.manage")).toBe(true);
    expect(p.can("organizations.manage")).toBe(false);
    expect(p.can("system.manage")).toBe(false);
  });

  it("super_admin has platform management permissions", () => {
    const p = makeActor("super_admin");
    expect(p.can("system.manage")).toBe(true);
    expect(p.can("organizations.manage")).toBe(true);
    expect(p.can("billing.manage")).toBe(true);
    expect(p.can("permissions.manage")).toBe(true);
  });

  it("admin does not have permissions.manage by default", () => {
    const p = makeActor("admin");
    expect(p.can("permissions.manage")).toBe(false);
  });

  it("cashier has pos.use", () => {
    const p = makeActor("cashier");
    expect(p.can("pos.use")).toBe(true);
  });

  it("staff does not have pos.refund by default", () => {
    const p = makeActor("staff");
    expect(p.can("pos.refund")).toBe(false);
  });

  it("grant override adds permission to role that lacks it", () => {
    const p = resolvePermissions("cashier", [{ permissionKey: "reports.view", granted: true }], ORG, STORE);
    expect(p.can("reports.view")).toBe(true);
  });

  it("deny override removes permission from role that has it", () => {
    const p = resolvePermissions("manager", [{ permissionKey: "pos.discount", granted: false }], ORG, STORE);
    expect(p.can("pos.discount")).toBe(false);
  });
});

describe("validatePermissionMutation", () => {
  const base = {
    actorUserId: ACTOR_ID,
    targetMembershipId: "mem-1",
    targetUserId: TARGET_ID,
    targetOrganizationId: ORG,
    targetStoreId: STORE,
    targetRole: "cashier" as const,
    permissionKey: "pos.discount" as const,
    granted: true,
    reason: "promotion",
  };

  it("owner can grant permissions.manage to admin", () => {
    const actor = makeActor("owner");
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, permissionKey: "permissions.manage", targetRole: "admin" });
    expect(result.ok).toBe(true);
  });

  it("super_admin can modify owner permissions", () => {
    const actor = makeActor("super_admin");
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, targetRole: "owner", permissionKey: "permissions.manage" });
    expect(result.ok).toBe(true);
  });

  it("owner cannot modify a super_admin member", () => {
    const actor = makeActor("owner");
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, targetRole: "super_admin" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("super_admin_only");
  });

  it("owner cannot grant platform-only permissions", () => {
    const actor = makeActor("owner");
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, permissionKey: "system.manage" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("super_admin_only");
  });

  it("admin cannot grant permissions.manage (owner-only key)", () => {
    const actor = makeActor("admin");
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, permissionKey: "permissions.manage" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("owner_only");
  });

  it("admin without permissions.manage cannot mutate any permission", () => {
    const actor = makeActor("admin");
    const result = validatePermissionMutation({ ...base, actorPermissions: actor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("actor_lacks_permissions_manage");
  });

  it("admin with permissions.manage override can grant pos.discount", () => {
    const actor = resolvePermissions("admin", [{ permissionKey: "permissions.manage", granted: true }], ORG, STORE);
    const result = validatePermissionMutation({ ...base, actorPermissions: actor });
    expect(result.ok).toBe(true);
  });

  it("cross-tenant mutation is rejected", () => {
    const actor = makeActor("owner");
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, targetOrganizationId: "other-org" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("cross_tenant");
  });

  it("actor cannot grant a permission they do not have (escalation denied)", () => {
    const actor = resolvePermissions("staff", [{ permissionKey: "permissions.manage", granted: true }], ORG, STORE);
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, permissionKey: "reports.view", granted: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("escalation_denied");
  });

  it("actor cannot modify a member with owner role unless actor is owner", () => {
    const actor = resolvePermissions("admin", [{ permissionKey: "permissions.manage", granted: true }], ORG, STORE);
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, targetRole: "owner" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("owner_only");
  });

  it("self-edit is rejected", () => {
    const actor = makeActor("owner");
    const result = validatePermissionMutation({ ...base, actorPermissions: actor, actorUserId: TARGET_ID, targetUserId: TARGET_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("self_edit");
  });
});
