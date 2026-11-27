import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE } from "@/modules/billing/types";
import { decideTaxDocumentsAccess } from "./access-policy";
import { isTaxDocumentsEnabled } from "./documents-repository";
import { getStoreTaxProfile } from "./repository";

/** ด่านเดียวของหน้า/แอ็กชันใบกำกับภาษี — DB ตรวจซ้ำอีกชั้นใน RPC */
export async function getTaxDocumentsAccess() {
  const { user, ctx } = await getResolvedCurrentPermissions();
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const hasFeature = canUseFeature(billing, "taxDocuments");
  const [enabled, profileRes] = hasFeature
    ? await Promise.all([isTaxDocumentsEnabled(ctx.storeId), getStoreTaxProfile(ctx.storeId)])
    : [false, { data: null, error: null }];
  const profile = profileRes.data ?? null;
  const decision = decideTaxDocumentsAccess({
    hasFeature,
    role: ctx.role,
    enabled,
    vatRegistered: Boolean(profile?.vatRegistered),
  });
  return { user, ctx, decision, profile, hasFeature };
}
