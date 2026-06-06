import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { listStoreMemberships } from "@/modules/settings/repository";
import { TeamSettings } from "./TeamSettings";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");

  const membersRes = await listStoreMemberships(ctx.organizationId, ctx.storeId);

  return (
    <TeamSettings
      members={membersRes.data ?? []}
      currentUserId={user.id}
      canManageUsers={resolved.can("users.manage")}
      canManagePermissions={resolved.can("permissions.manage")}
      canManagePlatform={resolved.can("system.manage")}
    />
  );
}
