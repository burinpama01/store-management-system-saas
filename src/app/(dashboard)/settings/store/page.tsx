import { redirect } from "next/navigation";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getStore } from "@/modules/stores/repository";
import { StoreSettingsForm } from "./StoreSettingsForm";

export const dynamic = "force-dynamic";

export default async function StoreSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) {
    redirect(resolved.can("settings.manage_printer") ? "/settings/receipt" : "/dashboard");
  }

  const storeRes = await getStore(ctx.storeId);
  if (!storeRes.data) redirect("/dashboard");

  const canEdit = resolved.can("settings.manage_store");
  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);
  const canUseQrOrdering = features.qrOrdering;
  const canUseBuffet = features.buffetManagement;

  return (
    <StoreSettingsForm
      store={storeRes.data}
      canEdit={canEdit}
      canUseQrOrdering={canUseQrOrdering}
      canUseBuffet={canUseBuffet}
    />
  );
}
