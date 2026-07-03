import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { listChannelLinks, getDeliveryProducts } from "@/modules/connect/repository";
import { getJdcFunctionsBaseUrl, getJdcWebhookSecret } from "@/modules/billing/platform-settings";
import { ConnectManager } from "./ConnectManager";

export const dynamic = "force-dynamic";

export default async function ConnectSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");
  if (!resolved.can("settings.manage_store")) redirect("/settings/store");

  const billing =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const featureEnabled = canUseFeature(billing, "apiIntegration");

  const [links, deliveryProducts, jdcBaseUrl, jdcSecret] = await Promise.all([
    listChannelLinks(ctx.organizationId),
    getDeliveryProducts(ctx.storeId),
    getJdcFunctionsBaseUrl(),
    getJdcWebhookSecret(),
  ]);

  return (
    <div className="page-shell">
      <ConnectManager
        links={links.map((l) => ({
          id: l.id,
          channel: l.channel,
          externalMerchantId: l.externalMerchantId,
          status: l.status,
          autoAccept: l.autoAccept,
          commissionRate: l.commissionRate,
          storeId: l.storeId,
        }))}
        deliveryProductCount={deliveryProducts.length}
        featureEnabled={featureEnabled}
        jdcConfigured={Boolean(jdcBaseUrl && jdcSecret)}
      />
    </div>
  );
}
