import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listStoreMemberships } from "@/modules/settings/repository";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE, explainFeatureLock } from "@/modules/billing/types";
import { TeamSettings } from "./TeamSettings";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("users.manage") && !resolved.can("permissions.manage")) redirect("/settings/store");

  const membersRes = await listStoreMemberships(ctx.organizationId, ctx.storeId);

  // Per-user permission overrides are an advanced-permissions feature (premium+).
  const billingState = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const advancedPermissionsEnabled = canUseFeature(billingState, "advancedPermissions");
  const permissionsLockedMessage = advancedPermissionsEnabled
    ? null
    : explainFeatureLock(billingState, "advancedPermissions") ?? "แพ็กเกจนี้ยังไม่รองรับการกำหนดสิทธิ์รายบุคคล";

  return (
    <TeamSettings
      members={membersRes.data ?? []}
      currentUserId={user.id}
      canManageUsers={resolved.can("users.manage")}
      canManagePermissions={resolved.can("permissions.manage") && advancedPermissionsEnabled}
      permissionsLockedMessage={resolved.can("permissions.manage") ? permissionsLockedMessage : null}
      canManagePlatform={resolved.can("system.manage")}
    />
  );
}
