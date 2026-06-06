import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { getPlatformSettings } from "@/modules/billing/platform-settings";
import { isPaidTier, isSubscriptionCurrent } from "@/modules/billing/pricing";
import { isSlip2goConfigured } from "@/modules/billing/slip2go";
import { BillingManager } from "./BillingManager";

export const dynamic = "force-dynamic";

export default async function BillingSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const settings = await getPlatformSettings();

  const active =
    isPaidTier(billingState.plan) && isSubscriptionCurrent(billingState.currentPeriodEnd);

  return (
    <BillingManager
      orgName={ctx.orgName}
      plan={billingState.plan}
      currentPeriodEnd={billingState.currentPeriodEnd}
      isActive={active}
      canManage={resolved.can("billing.manage")}
      paymentConfigured={Boolean(settings.promptpayId || settings.promptpayStaticPayload)}
      recipientName={settings.promptpayName}
      slipVerificationReady={isSlip2goConfigured()}
    />
  );
}
