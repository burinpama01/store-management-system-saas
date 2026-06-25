import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions, requireFeature, requirePermission } from "@/modules/auth/guards";
import { listCategories, listProducts } from "@/modules/catalog/repository";
import { getReceiptSettings, getStore, listPrinters } from "@/modules/stores/repository";
import { buildThemeStyle } from "@/modules/theme/presets";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE, explainFeatureLock } from "@/modules/billing/types";
import { GroceryPosTerminal } from "./GroceryPosTerminal";

export const dynamic = "force-dynamic";

export default async function GroceryPosPage() {
  await requirePermission("pos.use");
  await requireFeature("groceryPos");
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("pos.use")) redirect("/dashboard");

  const [categoriesResult, productsResult, receiptSettingsResult, storeResult, printersResult, billingState] = await Promise.all([
    listCategories(ctx.storeId),
    listProducts(ctx.storeId, { includeInactive: false }),
    getReceiptSettings(ctx.storeId),
    getStore(ctx.storeId),
    listPrinters(ctx.storeId, ctx.organizationId),
    getOrganizationBillingState(ctx.organizationId),
  ]);
  const resolvedBillingState = billingState ?? DEFAULT_BILLING_STATE;
  const offlineEnabled = canUseFeature(resolvedBillingState, "offlinePos");
  const offlineUnavailableMessage = offlineEnabled
    ? null
    : explainFeatureLock(resolvedBillingState, "offlinePos") ?? "แพ็กเกจนี้ยังไม่รองรับ Offline POS";

  const themeStyle = buildThemeStyle({
    presetId: ctx.themePresetId,
    primaryColor: ctx.themePrimaryColor,
    primaryStrongColor: ctx.themePrimaryStrongColor,
    primarySoftColor: ctx.themePrimarySoftColor,
    accentColor: ctx.themeAccentColor,
  });

  return (
    <div style={themeStyle}>
      <GroceryPosTerminal
        storeId={ctx.storeId}
        storeName={ctx.storeName}
        categories={categoriesResult.data ?? []}
        products={productsResult.data ?? []}
        receiptSettings={receiptSettingsResult.data ?? null}
        currency={storeResult.data?.currencyCode ?? "THB"}
        printers={printersResult.data ?? []}
        printerLoadError={printersResult.error?.userMessage ?? null}
        offlineEnabled={offlineEnabled}
        offlineUnavailableMessage={offlineUnavailableMessage}
      />
    </div>
  );
}
