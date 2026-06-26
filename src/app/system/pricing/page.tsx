import { requireSystemAccess } from "@/modules/auth/guards";
import {
  listBillingPrices,
  listPromotions,
  listPlanSettings,
  listDiscountCodes,
} from "@/modules/billing/pricing-repository";
import { PricingManager } from "./PricingManager";

export const dynamic = "force-dynamic";

export default async function SystemPricingPage() {
  await requireSystemAccess();
  const [prices, promotions, planSettings, discountCodes] = await Promise.all([
    listBillingPrices(),
    listPromotions(),
    listPlanSettings(),
    listDiscountCodes(),
  ]);
  return (
    <PricingManager
      prices={prices}
      promotions={promotions}
      planSettings={planSettings}
      discountCodes={discountCodes}
    />
  );
}
