import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import {
  listChannelLinks,
  listConnectOrders,
  getDeliveryProducts,
} from "@/modules/connect/repository";
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

  const [links, orders, deliveryProducts, jdcBaseUrl, jdcSecret] = await Promise.all([
    listChannelLinks(ctx.organizationId),
    listConnectOrders(ctx.organizationId, 50),
    getDeliveryProducts(ctx.storeId),
    getJdcFunctionsBaseUrl(),
    getJdcWebhookSecret(),
  ]);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const webhookUrl = host ? `${proto}://${host}/api/connect/v1/webhooks/jdc/order` : "";

  return (
    <div className="page-shell">
      <ConnectManager
        links={links.map((l) => ({
          id: l.id,
          channel: l.channel,
          externalMerchantId: l.externalMerchantId,
          status: l.status,
          autoAccept: l.autoAccept,
          storeId: l.storeId,
        }))}
        orders={orders.map((o) => ({
          id: o.id,
          externalOrderId: o.externalOrderId,
          fulfillmentStatus: o.fulfillmentStatus,
          lastStatusOrigin: o.lastStatusOrigin,
          orderNumber: o.orderNumber,
          total: o.total,
          receivedAt: o.receivedAt,
        }))}
        deliveryProductCount={deliveryProducts.length}
        webhookUrl={webhookUrl}
        featureEnabled={featureEnabled}
        jdcConfigured={Boolean(jdcBaseUrl && jdcSecret)}
        canManageOrders={resolved.can("orders.manage_qr")}
      />
    </div>
  );
}
