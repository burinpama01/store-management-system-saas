import { requireSystemAccess } from "@/modules/auth/guards";
import { listBillingPrices, listPromotions } from "@/modules/billing/pricing-repository";
import { PricingManager } from "./PricingManager";

export const dynamic = "force-dynamic";

export default async function SystemPricingPage() {
  await requireSystemAccess();
  const [prices, promotions] = await Promise.all([listBillingPrices(), listPromotions()]);
  return <PricingManager prices={prices} promotions={promotions} />;
}
