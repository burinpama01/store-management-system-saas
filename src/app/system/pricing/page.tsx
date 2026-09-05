import { requireSystemAccess } from "@/modules/auth/guards";
import {
  getBusinessPriceMap,
  listBillingPrices,
  listPromotions,
  listPlanSettings,
  listDiscountCodes,
} from "@/modules/billing/pricing-repository";
import { getFreeTrialCampaign } from "@/modules/billing/platform-settings";
import { listAllCreditPacks } from "@/modules/ai/credits";
import { AI_MAX_OUTPUT_TOKENS, AI_MONTHLY_TOKEN_BUDGET } from "@/modules/ai/quota";
import { PricingManager } from "./PricingManager";

export const dynamic = "force-dynamic";

export default async function SystemPricingPage() {
  await requireSystemAccess();
  const [prices, businessPrices, promotions, planSettings, discountCodes, freeTrial, aiCreditPacks] = await Promise.all([
    listBillingPrices(),
    getBusinessPriceMap(),
    listPromotions(),
    listPlanSettings(),
    listDiscountCodes(),
    getFreeTrialCampaign(),
    listAllCreditPacks(),
  ]);
  return (
    <PricingManager
      prices={prices}
      businessPrices={businessPrices}
      promotions={promotions}
      planSettings={planSettings}
      discountCodes={discountCodes}
      freeTrial={freeTrial}
      aiCreditPacks={aiCreditPacks}
      aiMonthlyBudget={AI_MONTHLY_TOKEN_BUDGET}
      aiTokensPerRequest={AI_MAX_OUTPUT_TOKENS}
    />
  );
}
