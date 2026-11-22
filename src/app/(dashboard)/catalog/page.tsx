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
import { getCostingAccess } from "@/modules/costing/access";
import { getConsignmentAccess } from "@/modules/consignment/access";
import { loadOptionRecipeData } from "@/modules/costing/repository";
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
    optionRecipe,
    consignmentEnabled,
  ] = await Promise.all([
    listCategories(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: true }),
    listVariantTemplates(ctx.storeId),
    listModifierGroupTemplates(ctx.storeId),
    listBranchStores(ctx.organizationId),
    listKitchenStations(ctx.storeId),
    getOrganizationBillingState(ctx.organizationId),
    // ปุ่ม "วัตถุดิบ" ข้างตัวเลือกเสริม — เฉพาะคนที่แก้ระบบต้นทุนได้ (ผู้จัดการ + แพ็กที่มีรายงานขั้นสูง)
    // โหลดไม่สำเร็จ = ซ่อนปุ่ม ไม่ทำให้หน้าเมนูล้ม
    getCostingAccess()
      .then(async (costing) =>
        costing.decision.allowed && costing.decision.canEdit ? ((await loadOptionRecipeData(ctx.storeId)).data ?? null) : null,
      )
      .catch(() => null),
    // ลิงก์ "ซื้อมาขาย/ฝากขาย" ในหน้าแก้เมนู — Enterprise + ผู้จัดการ + เปิดสวิตช์สาขา
    getConsignmentAccess()
      .then((c) => c.decision.allowed && c.decision.canOperate)
      .catch(() => false),
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
      <MenuScanWizard kitchenStations={kitchenStations} canUseQrOrdering={features.qrOrdering} />
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
        optionRecipe={optionRecipe}
        consignmentEnabled={consignmentEnabled}
      />
    </div>
  );
}
