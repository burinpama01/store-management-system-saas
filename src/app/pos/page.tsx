import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import type { PermissionKey } from "@/modules/tenants/types";
import { listCategories, listProducts } from "@/modules/catalog/repository";
import { getReceiptSettings, getStore } from "@/modules/stores/repository";
import { getOpenCashSession, getCashSalesSince } from "@/modules/cashflow/repository";
import { buildThemeStyle } from "@/modules/theme/presets";
import { PosTerminal } from "./PosTerminal";

export const dynamic = "force-dynamic";

/** First non-POS route the user can reach, used as the POS "exit" target. */
function firstHomeRoute(can: (p: PermissionKey) => boolean): string | null {
  const routes: Array<[PermissionKey, string]> = [
    ["dashboard.view", "/dashboard"],
    ["catalog.view", "/catalog"],
    ["cashflow.view", "/accounting"],
    ["reports.view", "/reports"],
    ["attendance.clock", "/attendance"],
    ["settings.view", "/settings"],
  ];
  return routes.find(([p]) => can(p))?.[1] ?? null;
}

export default async function PosPage() {
  const { ctx, resolved } = await getResolvedCurrentPermissions();
  if (!resolved.can("pos.use")) {
    redirect(firstHomeRoute(resolved.can) ?? "/dashboard");
  }

  const [categoriesResult, productsResult, receiptSettingsResult, storeResult, cashSessionResult] =
    await Promise.all([
      listCategories(ctx.storeId),
      listProducts(ctx.storeId, { includeInactive: false }),
      getReceiptSettings(ctx.storeId),
      getStore(ctx.storeId),
      getOpenCashSession(ctx.storeId),
    ]);

  const cashSession = cashSessionResult.data ?? null;
  const cashSalesPreview = cashSession
    ? await getCashSalesSince(ctx.storeId, cashSession.openedAt)
    : 0;
  const themeStyle = buildThemeStyle({
    presetId: ctx.themePresetId,
    primaryColor: ctx.themePrimaryColor,
    primaryStrongColor: ctx.themePrimaryStrongColor,
    primarySoftColor: ctx.themePrimarySoftColor,
    accentColor: ctx.themeAccentColor,
  });

  return (
    <div style={themeStyle}>
      <PosTerminal
        storeId={ctx.storeId}
        storeName={ctx.storeName}
        categories={categoriesResult.data ?? []}
        products={productsResult.data ?? []}
        receiptSettings={receiptSettingsResult.data ?? null}
        exitHref={firstHomeRoute(resolved.can)}
        cashSession={cashSession}
        cashSalesPreview={cashSalesPreview}
        currency={storeResult.data?.currencyCode ?? "THB"}
      />
    </div>
  );
}
