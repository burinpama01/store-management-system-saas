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
import { listBranchStores } from "@/modules/stores/repository";
import { listKitchenStations } from "@/modules/qr-ordering/kitchen-stations";
import { CatalogManager } from "./CatalogManager";
import { MenuScanWizard } from "./MenuScanWizard";

export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("catalog.manage")) redirect("/dashboard");

  const [
    categoriesResult,
    productsResult,
    variantTemplatesResult,
    modifierGroupTemplatesResult,
    branchStoresResult,
    kitchenStationsResult,
    billingState,
  ] = await Promise.all([
    listCategories(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: true }),
    listVariantTemplates(ctx.storeId),
    listModifierGroupTemplates(ctx.storeId),
    listBranchStores(ctx.organizationId),
    listKitchenStations(ctx.storeId),
    getOrganizationBillingState(ctx.organizationId),
  ]);

  const categories = categoriesResult.data ?? [];
  const products = productsResult.data ?? [];
  const variantTemplates = variantTemplatesResult.data ?? [];
  const modifierGroupTemplates = modifierGroupTemplatesResult.data ?? [];
  const branchStores = branchStoresResult.data ?? [];
  const kitchenStations = (kitchenStationsResult.data ?? []).map((s) => ({ id: s.id, name: s.name }));
  const state = billingState ?? DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(state);

  return (
    <div className="min-h-full">
      <MenuScanWizard />
    <CatalogManager
        categories={categories}
        products={products}
        branchStores={branchStores}
        variantTemplates={variantTemplates}
        modifierGroupTemplates={modifierGroupTemplates}
        role={ctx.role}
        storeName={ctx.storeName}
        storeId={ctx.storeId}
        organizationId={ctx.organizationId}
        planName={state.plan}
        canManageCatalog={resolved.can("catalog.manage")}
        canUseMultiBranch={features.multiBranchReporting}
        canUseQrOrdering={features.qrOrdering}
        canUseStock={features.stockManagement}
        kitchenStations={kitchenStations}
      />
    </div>
  );
}
