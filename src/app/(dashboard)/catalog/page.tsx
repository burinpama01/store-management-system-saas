import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  listCategories,
  listModifierGroupTemplates,
  listProducts,
  listVariantTemplates,
} from "@/modules/catalog/repository";
import { CatalogManager } from "./CatalogManager";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("catalog.manage")) redirect("/dashboard");

  const [
    categoriesResult,
    productsResult,
    variantTemplatesResult,
    modifierGroupTemplatesResult,
    billingState,
  ] = await Promise.all([
    listCategories(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: true }),
    listVariantTemplates(ctx.storeId),
    listModifierGroupTemplates(ctx.storeId),
    getOrganizationBillingState(ctx.organizationId),
  ]);

  const categories = categoriesResult.data ?? [];
  const products = productsResult.data ?? [];
  const variantTemplates = variantTemplatesResult.data ?? [];
  const modifierGroupTemplates = modifierGroupTemplatesResult.data ?? [];
  const state = billingState ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(state);

  return (
    <div className="min-h-full">
      <CatalogManager
        categories={categories}
        products={products}
        variantTemplates={variantTemplates}
        modifierGroupTemplates={modifierGroupTemplates}
        role={ctx.role}
        storeName={ctx.storeName}
        storeId={ctx.storeId}
        organizationId={ctx.organizationId}
        planName={state.plan}
        canManageCatalog={resolved.can("catalog.manage")}
        canUseQrOrdering={features.qrOrdering}
        canUseStock={features.stockManagement}
      />
    </div>
  );
}
