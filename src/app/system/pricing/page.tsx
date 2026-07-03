import { requireSystemAccess } from "@/modules/auth/guards";
import {
  getBusinessPriceMap,
  listBillingPrices,
  listPromotions,
  listPlanSettings,
  listDiscountCodes,
} from "@/modules/billing/pricing-repository";
import { PricingManager } from "./PricingManager";

export const dynamic = "force-dynamic";

export default async function SystemPricingPage() {
  await requireSystemAccess();
  const [prices, businessPrices, promotions, planSettings, discountCodes] = await Promise.all([
    listBillingPrices(),
    getBusinessPriceMap(),
    listPromotions(),
    listPlanSettings(),
    listDiscountCodes(),
  ]);
  return (
    <PricingManager
      prices={prices}
      businessPrices={businessPrices}
      promotions={promotions}
      planSettings={planSettings}
      discountCodes={discountCodes}
    />
  );
}
