import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  canUseFeature,
  explainFeatureLock,
} from "@/modules/billing/types";
import { listActiveStores } from "@/modules/stores/repository";
import { BranchManager } from "./BranchManager";

export const dynamic = "force-dynamic";

export default async function BranchSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ??
    DEFAULT_BILLING_STATE;
  const branchEnabled = canUseFeature(billingState, "multiBranchReporting");
  const branchUnavailableMessage = branchEnabled
    ? null
    : explainFeatureLock(billingState, "multiBranchReporting") ??
      "แพ็กเกจปัจจุบันยังไม่รองรับหลายสาขา";
  const stores = (await listActiveStores(ctx.organizationId)).data ?? [];

  return (
    <BranchManager
      stores={stores}
      currentStoreId={ctx.storeId}
      canCreate={branchEnabled}
      unavailableMessage={branchUnavailableMessage}
    />
  );
}
