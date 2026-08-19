import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { getPlatformSettings } from "@/modules/billing/platform-settings";
import { hasBillingAccess } from "@/modules/billing/pricing";
import { getBusinessPriceMap, getFreeTrialEligibility, listBillingPrices } from "@/modules/billing/pricing-repository";
import { isSlip2goConfigured } from "@/modules/billing/slip2go";
import { listEnterpriseRequestsForOrg } from "@/modules/enterprise/repository";
import { BillingManager } from "./BillingManager";

export const dynamic = "force-dynamic";

export default async function BillingSettingsPage() {
  const { ctx, user, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/dashboard");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const settings = await getPlatformSettings();
  const prices = await listBillingPrices();
  const businessPrices = await getBusinessPriceMap();
  const freeTrial = await getFreeTrialEligibility(ctx.organizationId, user.id);
  const enterpriseRequests = await listEnterpriseRequestsForOrg(ctx.organizationId);
  const latestEnterpriseRequest = enterpriseRequests[0] ?? null;

  const active = hasBillingAccess(billingState);

  return (
    <BillingManager
      orgName={ctx.orgName}
      plan={billingState.plan}
      status={billingState.status}
      currentPeriodEnd={billingState.currentPeriodEnd}
      isActive={active}
      prices={prices}
      businessPrices={businessPrices}
      currentBusiness={billingState.business ?? null}
      canManage={resolved.can("billing.manage")}
      paymentConfigured={Boolean(settings.promptpayId || settings.promptpayStaticPayload)}
      recipientName={settings.promptpayName}
      slipVerificationReady={isSlip2goConfigured()}
      freeTrialAvailable={freeTrial.available}
      freeTrialEndsAt={freeTrial.campaignEndsAt}
      enterpriseRequest={
        latestEnterpriseRequest
          ? { status: latestEnterpriseRequest.status, createdAt: latestEnterpriseRequest.createdAt }
          : null
      }
    />
  );
}
