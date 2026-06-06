import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState, getStripeCustomerId } from "@/modules/billing/billing-service";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { BillingManager } from "./BillingManager";

export const dynamic = "force-dynamic";

export default async function BillingSettingsPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("settings.view")) redirect("/");

  const billingState =
    (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);
  const hasCustomer = Boolean(await getStripeCustomerId(ctx.organizationId));

  // Price IDs are server-only env values; the client only forwards them to the
  // checkout API which re-validates them against the same allowlist.
  const priceIds = {
    starter: process.env.STRIPE_PRICE_STARTER ?? null,
    standard: process.env.STRIPE_PRICE_STANDARD ?? null,
    premium: process.env.STRIPE_PRICE_PREMIUM ?? null,
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE ?? null,
  };

  return (
    <BillingManager
      billingState={billingState}
      features={features}
      canManage={resolved.can("billing.manage")}
      hasCustomer={hasCustomer}
      priceIds={priceIds}
      orgName={ctx.orgName}
    />
  );
}
