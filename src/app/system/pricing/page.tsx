import { requireSystemAccess } from "@/modules/auth/guards";
import {
  getBusinessPriceMap,
  listBillingPrices,
  listPromotions,
  listPlanSettings,
  listDiscountCodes,
} from "@/modules/billing/pricing-repository";
import { getFreeTrialCampaign } from "@/modules/billing/platform-settings";
import { PricingManager } from "./PricingManager";

export const dynamic = "force-dynamic";

export default async function SystemPricingPage() {
  await requireSystemAccess();
  const [prices, businessPrices, promotions, planSettings, discountCodes, freeTrial] = await Promise.all([
    listBillingPrices(),
    getBusinessPriceMap(),
    listPromotions(),
    listPlanSettings(),
    listDiscountCodes(),
    getFreeTrialCampaign(),
  ]);
  return (
    <PricingManager
      prices={prices}
      businessPrices={businessPrices}
      promotions={promotions}
      planSettings={planSettings}
      discountCodes={discountCodes}
      freeTrial={freeTrial}
    />
  );
}
