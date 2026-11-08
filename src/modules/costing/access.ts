import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE, explainFeatureLock } from "@/modules/billing/types";
import { parseSetupProfileOrNull } from "@/modules/onboarding/setup-profile";
import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { decideCostingAccess, type CostingAccessDecision } from "./access-policy";

/** ด่านเดียวของหน้า/แอ็กชันต้นทุน */
export async function getCostingAccess() {
  const { user, ctx, resolved } = await getResolvedCurrentPermissions();
  const billing = (await getOrganizationBillingState(ctx.organizationId)) ?? DEFAULT_BILLING_STATE;
  const hasAdvancedReports = canUseFeature(billing, "advancedReports");
  const supabase = await createSupabaseServerClient();
  const { data: store } = await supabase.from("stores").select("setup_profile").eq("id", ctx.storeId).maybeSingle();
  const profile = parseSetupProfileOrNull(store?.setup_profile);
  const decision: CostingAccessDecision = decideCostingAccess({
    canViewReports: resolved.can("reports.view"),
    canManageCatalog: resolved.can("catalog.manage"),
    role: ctx.role,
    hasAdvancedReports,
    planLockMessage: hasAdvancedReports ? null : explainFeatureLock(billing, "advancedReports"),
    businessMode: profile?.businessMode ?? null,
  });
  return { user, ctx, decision };
}
