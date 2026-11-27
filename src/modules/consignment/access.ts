import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { canSettleAtDailyClose, decideConsignmentAccess } from "./access-policy";
import { isConsignmentEnabled } from "./repository";

/** ด่านเดียวของหน้า/แอ็กชันสินค้าซื้อขาด/ฝากขาย */
export async function getConsignmentAccess() {
  const { user, ctx } = await getResolvedCurrentPermissions();
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const hasConsignment = canUseFeature(billing, "consignment");
  const enabled = hasConsignment ? await isConsignmentEnabled(ctx.storeId) : false;
  const decision = decideConsignmentAccess({ hasConsignment, role: ctx.role, enabled });
  return { user, ctx, decision };
}

/** ปิดรอบเงินสด: แคชเชียร์ขึ้นไป + Enterprise + เปิดสวิตช์ */
export async function getDailyCloseConsignmentAccess() {
  const { user, ctx } = await getResolvedCurrentPermissions();
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const hasConsignment = canUseFeature(billing, "consignment");
  const enabled = hasConsignment ? await isConsignmentEnabled(ctx.storeId) : false;
  return { user, ctx, allowed: canSettleAtDailyClose({ hasConsignment, role: ctx.role, enabled }) };
}
