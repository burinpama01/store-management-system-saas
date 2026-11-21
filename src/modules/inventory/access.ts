import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE, explainFeatureLock } from "@/modules/billing/types";
import { getCostingAccess } from "@/modules/costing/access";
import { decideInventoryAccess } from "./access-policy";
import { isInventoryEnabled } from "./repository";

/** ด่านเดียวของหน้า/แอ็กชันคลังวัตถุดิบและผู้ขาย */
export async function getInventoryAccess() {
  const { user, ctx, decision: costing } = await getCostingAccess();
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const hasStockManagement = canUseFeature(billing, "stockManagement");
  const enabled = costing.allowed && hasStockManagement ? await isInventoryEnabled(ctx.storeId) : false;
  const decision = decideInventoryAccess({
    costing,
    hasStockManagement,
    stockPlanLockMessage: hasStockManagement ? null : explainFeatureLock(billing, "stockManagement"),
    role: ctx.role,
    enabled,
  });
  return { user, ctx, decision };
}
