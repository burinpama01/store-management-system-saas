import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import { DEFAULT_BILLING_STATE, getPlanFeatures } from "@/modules/billing/types";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { listCategories, listProducts } from "@/modules/catalog/repository";
import { CatalogManager } from "./CatalogManager";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("catalog.view")) redirect("/");

  const [categoriesResult, productsResult, billingState] = await Promise.all([
    listCategories(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: true }),
    getOrganizationBillingState(ctx.organizationId),
  ]);

  const categories = categoriesResult.data ?? [];
  const products = productsResult.data ?? [];
  const state = billingState ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(state);

  return (
    <div className="min-h-full">
      <CatalogManager
        categories={categories}
        products={products}
        role={ctx.role}
        storeName={ctx.storeName}
        planName={state.plan}
        canManageCatalog={resolved.can("catalog.manage")}
        canUseQrOrdering={features.qrOrdering}
        canUseStock={features.stockManagement}
      />
    </div>
  );
}
