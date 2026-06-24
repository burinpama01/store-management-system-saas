import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions, requireFeature } from "@/modules/auth/guards";
import { getCustomerDisplaySettings } from "@/modules/settings/repository";
import { CustomerDisplaySettingsForm } from "./CustomerDisplaySettingsForm";

export const dynamic = "force-dynamic";

export default async function CustomerDisplaySettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");
  await requireFeature("customerDisplay");

  const settingsRes = await getCustomerDisplaySettings(ctx.storeId, ctx.organizationId);

  return (
    <div className="page-shell">
      <CustomerDisplaySettingsForm
        settings={settingsRes.data}
        storeName={ctx.storeName}
        loadError={settingsRes.error?.userMessage ?? null}
      />
    </div>
  );
}
