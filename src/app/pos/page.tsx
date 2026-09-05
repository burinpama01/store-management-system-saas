import { redirect } from "next/navigation";
import { getResolvedCurrentPermissions } from "@/modules/auth/guards";
import type { PermissionKey } from "@/modules/tenants/types";
import { listCategories, listProducts } from "@/modules/catalog/repository";
import { getReceiptSettings, getStore, listPrinters, listStoreTables } from "@/modules/stores/repository";
import { getOpenCashSession, getCashSalesSince, getCashMovementSince } from "@/modules/cashflow/repository";
import { buildThemeStyle } from "@/modules/theme/presets";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import { canUseFeature, DEFAULT_BILLING_STATE, explainFeatureLock } from "@/modules/billing/types";
import { PosTerminal } from "./PosTerminal";
import { resolveUnifiedPosSurface, toUnifiedTableSummaries } from "./unified/types";
import { UnifiedPosWorkspace } from "./unified/UnifiedPosWorkspace";
import { listUnifiedPosKitchenQueue } from "@/modules/unified-pos/kitchen-repository";
import { DASHBOARD_COMMANDS } from "@/modules/assistant/command-index";
import { listVoiceAliases } from "@/modules/voice-pos/alias-repository";

export const dynamic = "force-dynamic";

/** First non-POS route the user can reach, used as the POS "exit" target. */
function firstHomeRoute(can: (p: PermissionKey) => boolean): string | null {
  const routes: Array<[PermissionKey, string]> = [
    ["dashboard.view", "/dashboard"],
    ["catalog.manage", "/catalog"],
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

  const [categoriesResult, productsResult, receiptSettingsResult, storeResult, cashSessionResult, printersResult, billingState] =
    await Promise.all([
      listCategories(ctx.storeId),
      listProducts(ctx.storeId, { includeInactive: false }),
      getReceiptSettings(ctx.storeId),
      getStore(ctx.storeId),
      getOpenCashSession(ctx.storeId),
      listPrinters(ctx.storeId, ctx.organizationId),
      getOrganizationBillingState(ctx.organizationId),
    ]);

  const cashSession = cashSessionResult.data ?? null;
  const [cashSalesPreview, cashMovementPreview] = cashSession
    ? await Promise.all([
        getCashSalesSince(ctx.storeId, cashSession.openedAt),
        getCashMovementSince(ctx.storeId, cashSession.openedAt),
      ])
    : [0, 0];
  const themeStyle = buildThemeStyle({
    presetId: ctx.themePresetId,
    primaryColor: ctx.themePrimaryColor,
    primaryStrongColor: ctx.themePrimaryStrongColor,
    primarySoftColor: ctx.themePrimarySoftColor,
    accentColor: ctx.themeAccentColor,
  });
  const resolvedBillingState = billingState ?? DEFAULT_BILLING_STATE;
  const couponEnabled = canUseFeature(resolvedBillingState, "couponManagement");
  const loyaltyEnabled = canUseFeature(resolvedBillingState, "loyaltyPoints");
  const customerDisplayEnabled = canUseFeature(resolvedBillingState, "customerDisplay");
  const couponUnavailableMessage = couponEnabled
    ? null
    : explainFeatureLock(resolvedBillingState, "couponManagement") ?? "แพ็กเกจนี้ยังไม่รองรับคูปอง";
  const loyaltyUnavailableMessage = loyaltyEnabled
    ? null
    : explainFeatureLock(resolvedBillingState, "loyaltyPoints") ?? "แพ็กเกจนี้ยังไม่รองรับสะสมแต้ม";
  const customerDisplayUnavailableMessage = customerDisplayEnabled
    ? null
    : explainFeatureLock(resolvedBillingState, "customerDisplay") ?? "แพ็กเกจนี้ยังไม่รองรับจอลูกค้า";

  // U9 — gate เดียวจาก stores.unified_pos_enabled (default false = พฤติกรรมเดิมทุกอย่าง)
  const surface = resolveUnifiedPosSurface(storeResult.data);
  const terminal = (
    <PosTerminal
      storeId={ctx.storeId}
      storeName={ctx.storeName}
      categories={categoriesResult.data ?? []}
      products={(productsResult.data ?? []).filter((p) => !p.outOfStock)}
      receiptSettings={receiptSettingsResult.data ?? null}
      exitHref={firstHomeRoute(resolved.can)}
      cashSession={cashSession}
      cashSalesPreview={cashSalesPreview}
      cashMovementPreview={cashMovementPreview}
      currency={storeResult.data?.currencyCode ?? "THB"}
      canDiscount={resolved.can("pos.discount")}
      canRecordCashflow={resolved.can("cashflow.record")}
      storeTimezone={ctx.storeTimezone}
      printers={printersResult.data ?? []}
      printerLoadError={printersResult.error?.userMessage ?? null}
      couponEnabled={couponEnabled}
      couponUnavailableMessage={couponUnavailableMessage}
      loyaltyEnabled={loyaltyEnabled}
      loyaltyUnavailableMessage={loyaltyUnavailableMessage}
      customerDisplayEnabled={customerDisplayEnabled}
      customerDisplayUnavailableMessage={customerDisplayUnavailableMessage}
    />
  );

  if (surface === "legacy") {
    return (
      // POS กินเต็มจอพอดี — ไม่มีการเลื่อนทั้งหน้า (เลื่อนได้เฉพาะรายการเมนู/ออร์เดอร์ข้างใน)
      <div style={themeStyle} className="h-dvh overflow-hidden">
        {terminal}
      </div>
    );
  }

  // โต๊ะ + คิวครัวเป็นข้อมูลเฉพาะของ shell — โหลดเฉพาะเมื่อ flag เปิด (legacy path ไม่เพิ่ม query)
  const tablesResult = await listStoreTables(ctx.storeId);
  // U10 — snapshot คิวครัวตอนโหลดหน้า (หลังจากนี้แท็บครัวอัปเดตเองผ่าน realtime/polling)
  const kitchenQueueResult = await listUnifiedPosKitchenQueue(ctx.storeId);
  // U16 — คำเรียกที่ร้านสร้างเอง โหลดเฉพาะเมื่อเปิดใช้งานเสียง (flag ปิด = ไม่ query เพิ่ม)
  const voiceEnabled = storeResult.data?.voiceCommandEnabled ?? false;
  // ทางสำรอง AI เป็นคันโยกแยก: ต้องเปิดทั้งเสียงและ AI ถึงจะยิงออกไปได้
  const voiceAiFallbackEnabled = voiceEnabled && (storeResult.data?.voiceAiFallbackEnabled ?? false);
  const voiceAliasesResult = voiceEnabled
    ? await listVoiceAliases(ctx.storeId)
    : { data: [], error: null };
  return (
    <div style={themeStyle} className="h-dvh overflow-hidden">
      <UnifiedPosWorkspace
        storeId={ctx.storeId}
        storeName={ctx.storeName}
        tables={toUnifiedTableSummaries(tablesResult.data ?? [])}
        sell={terminal}
        kitchenInitialItems={kitchenQueueResult.data ?? []}
        voiceEnabled={voiceEnabled}
        voiceAiFallbackEnabled={voiceAiFallbackEnabled}
        voiceAliases={(voiceAliasesResult.data ?? [])
          .filter(
            (alias) =>
              alias.isActive && alias.intentType === "navigate" && typeof alias.slots.query === "string",
          )
          .map((alias) => ({ aliasText: alias.aliasText, query: alias.slots.query as string }))}
        voiceProductAliases={(voiceAliasesResult.data ?? [])
          .filter(
            (alias) =>
              alias.isActive && alias.intentType === "product" && typeof alias.slots.product_id === "string",
          )
          .map((alias) => ({ aliasText: alias.aliasText, productId: alias.slots.product_id as string }))}
        voiceCommands={DASHBOARD_COMMANDS.filter((command) =>
          resolved.can(command.permission as PermissionKey),
        )}
      />
    </div>
  );
}
