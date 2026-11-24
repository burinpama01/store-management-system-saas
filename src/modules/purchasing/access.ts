import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { isInventoryEnabled } from "@/modules/inventory/repository";
import { decidePurchaseSubmit } from "./access-policy";

/** ด่านส่งบิลซื้อ/อัปโหลดรูปของพนักงานทุกระดับ (Plan v5) — DB ตรวจซ้ำใน purchase_assert_submitter */
export async function getPurchaseSubmitAccess() {
  const { user, ctx } = await getResolvedCurrentPermissions();
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const hasStockManagement = canUseFeature(billing, "stockManagement");
  const inventoryEnabled = hasStockManagement ? await isInventoryEnabled(ctx.storeId) : false;
  const decision = decidePurchaseSubmit({ hasStockManagement, inventoryEnabled, role: ctx.role });
  return { user, ctx, decision };
}
