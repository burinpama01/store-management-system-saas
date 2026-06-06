import { requireSystemAccess } from "@/modules/auth/guards";
import { listBillingPrices, listPromotions, listPlanSettings } from "@/modules/billing/pricing-repository";
import { PricingManager } from "./PricingManager";

export const dynamic = "force-dynamic";

export default async function SystemPricingPage() {
  await requireSystemAccess();
  const [prices, promotions, planSettings] = await Promise.all([
    listBillingPrices(),
    listPromotions(),
    listPlanSettings(),
  ]);
  return <PricingManager prices={prices} promotions={promotions} planSettings={planSettings} />;
}
