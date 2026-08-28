import type { CSSProperties, ReactNode } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { PermissionKey } from "@/modules/tenants/types";
import { getResolvedCurrentPermissions, shouldStartAtAttendance } from "@/modules/auth/guards";
import { getUserStores } from "@/modules/auth/session";
import { buildThemeStyle } from "@/modules/theme/presets";
import {
  listAssignedKitchenStationIdsForUser,
  listKitchenStations,
} from "@/modules/qr-ordering/kitchen-stations";
import { getReceiptSettings } from "@/modules/settings/repository";
import { parseSetupProfileOrNull } from "@/modules/onboarding/setup-profile";
import { listPrinters } from "@/modules/stores/repository";
import { StoreSwitcher } from "@/shared/components/store-switcher";
import { SideNav } from "@/shared/components/SideNav";
import { QrOrderGlobalNotifier } from "./QrOrderGlobalNotifier";
import { DeliveryGlobalNotifier } from "./DeliveryGlobalNotifier";
import { NotificationGlobalNotifier } from "./NotificationGlobalNotifier";
import { PushTokenRegistrar } from "./PushTokenRegistrar";
import { signOut } from "./actions";
import { SubmitButton } from "@/shared/components/ui";
import { CommandPalette } from "@/shared/components/CommandPalette";
import type { CommandItem } from "@/modules/assistant/command-index";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, ctx: storeContext, resolved } = await getResolvedCurrentPermissions();
  if (!storeContext) redirect("/login");
  // super_admin is a platform operator with no store dashboard.
  if (storeContext.role === "super_admin") redirect("/system");
  const path = (await headers()).get("x-pathname") ?? "";
  if (path !== "/attendance" && (await shouldStartAtAttendance({ user, ctx: storeContext, resolved }))) {
    redirect("/attendance");
  }
  const { stores } = await getUserStores();
  const can = (permission: PermissionKey) => resolved.can(permission);
  const canManageQr = can("orders.manage_qr");
  const currentStoreRow = stores.find((s) => s.id === storeContext.storeId) as
    | {
        buffet_enabled?: boolean;
        qr_ordering_enabled?: boolean;
        music_request_enabled?: boolean;
        music_license_status?: string;
        setup_profile?: unknown;
      }
    | undefined;
  const qrOrderingEnabled = Boolean(currentStoreRow?.qr_ordering_enabled);
  // F1: profile-driven nav hiding — legacy stores (no profile) keep the legacy nav;
  // permission checks still gate every route, hiding is presentation only.
  const setupProfile = parseSetupProfileOrNull(currentStoreRow?.setup_profile);
  const qrOrdersVisible = canManageQr && setupProfile?.usesTables !== false;
  const musicRequestsVisible =
    canManageQr &&
    Boolean(currentStoreRow?.music_request_enabled) &&
    currentStoreRow?.music_license_status === "approved";
  const assignedKitchenStationIds =
    canManageQr && qrOrderingEnabled && storeContext.role === "staff"
      ? (await listAssignedKitchenStationIdsForUser(storeContext.storeId, user.id)).data ?? []
      : [];
  const [stationsForPrinting, receiptSettingsForPrinting, printersForPrinting] =
    canManageQr
      ? await Promise.all([
          listKitchenStations(storeContext.storeId),
          getReceiptSettings(storeContext.storeId, storeContext.organizationId),
          listPrinters(storeContext.storeId, storeContext.organizationId),
        ])
      : [{ data: [] }, { data: null }, { data: [] }];
  const receiptPrinters = printersForPrinting.data ?? [];
  const stationPrinters = (stationsForPrinting.data ?? [])
    .filter((station) => station.printerId)
    .map((station) => ({ id: station.id, name: station.name, printerId: station.printerId }));
  const deliveryStationPrinters = (stationsForPrinting.data ?? [])
    .filter((station) => station.printerId)
    .map((station) => ({ id: station.id, name: station.name, printerId: station.printerId as string }));
  const autoPrintStationTickets = Boolean(receiptSettingsForPrinting.data?.autoPrintStationTickets);
  const receiptPaperWidth = receiptSettingsForPrinting.data?.paperWidth === "58mm" ? "58mm" : "80mm";
  const navItems = [
    ...(can("dashboard.view") ? [{ href: "/dashboard", label: "ภาพรวม" }] : []),
    ...(can("catalog.manage") ? [{ href: "/catalog", label: "เมนูสินค้า" }] : []),
    ...(can("stock.manage") ? [{ href: "/stock", label: "สต็อก" }] : []),
    ...(can("pos.use") ? [{ href: "/pos", label: "POS" }] : []),
    ...(can("catalog.manage") ? [{ href: "/customers", label: "ลูกค้า" }] : []),
    ...(qrOrdersVisible ? [{ href: "/qr-orders", label: "QR Order" }] : []),
    ...(canManageQr ? [{ href: "/delivery", label: "เดลิเวอรี" }] : []),
    ...(musicRequestsVisible ? [{ href: "/music-requests", label: "ขอเพลง" }] : []),
    ...(can("cashflow.view") ? [{ href: "/accounting", label: "บัญชี" }] : []),
    ...(can("reports.view") ? [{ href: "/reports", label: "รายงาน" }] : []),
    ...(can("reports.view") ? [{ href: "/notifications", label: "แจ้งเตือน" }] : []),
    ...(can("attendance.clock") ? [{ href: "/attendance", label: "การเข้างาน" }] : []),
    ...(can("attendance.manage") ? [{ href: "/staff", label: "พนักงาน" }] : []),
    ...(
      storeContext && canManageQr && currentStoreRow?.buffet_enabled
        ? [{ href: "/buffet", label: "บุฟเฟต์" }]
        : []
    ),
    ...(can("settings.view") ? [{ href: "/settings", label: "ตั้งค่า" }] : []),
    ...(can("system.manage") ? [{ href: "/system", label: "ระบบ (Platform)" }] : []),
  ];
  // Task 12/E: Ctrl+K palette — ชั้น 1 deterministic fuzzy search (no AI).
  const commandItems: CommandItem[] = [
    ...navItems.map((item) => ({ id: item.href, label: item.label, href: item.href, permission: "nav", formFactors: ["mobile", "tablet", "desktop"] as const })),
    ...(can("settings.manage_printer") ? ([{ id: "/settings/receipt", label: "เครื่องพิมพ์", href: "/settings/receipt", permission: "settings.manage_printer", formFactors: ["desktop"] as const }, { id: "/settings/print-hub", label: "Print Hub", href: "/settings/print-hub", permission: "settings.manage_printer", formFactors: ["desktop"] as const }, { id: "/settings/devices", label: "อุปกรณ์นี้", href: "/settings/devices", permission: "settings.manage_printer", formFactors: ["desktop"] as const }]) : []),
    ...(can("settings.manage_store") ? [{ id: "/onboarding", label: "ตั้งค่าเริ่มต้น", href: "/onboarding", permission: "settings.manage_store", formFactors: ["mobile", "tablet", "desktop"] as const }] : []),
  ];
  const themeStyle = buildThemeStyle({
    presetId: storeContext.themePresetId,
    primaryColor: storeContext.themePrimaryColor,
    primaryStrongColor: storeContext.themePrimaryStrongColor,
    primarySoftColor: storeContext.themePrimarySoftColor,
    accentColor: storeContext.themeAccentColor,
  }) as CSSProperties;

  return (
    <div className="storeos-app" style={themeStyle}>
      <aside className="storeos-sidebar hidden md:flex">
        <div className="brand">
          <div className="brand-mark brand-mark--logo" aria-hidden="true" />
          <div className="min-w-0">
            <div className="brand-name">StoreOS</div>
            <div className="brand-sub truncate">{storeContext?.orgName ?? "ระบบจัดการร้าน"}</div>
          </div>
        </div>
        <div className="store-switch-shell">
          {storeContext ? (
            <StoreSwitcher stores={stores} currentStoreId={storeContext.storeId} />
          ) : (
            <span className="store-switch text-sm text-[var(--muted)]">ไม่มีร้านค้า</span>
          )}
        </div>
        <SideNav items={navItems} />
        <div className="border-t border-[var(--border)] p-3">
          <div className="mb-3 flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] p-2 hover:bg-[var(--surface-muted)]">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--tenant-primary-soft)] text-sm font-extrabold text-[var(--tenant-primary-strong)]">
              {user.email?.slice(0, 1).toUpperCase() ?? "U"}
            </span>
            {/* tablet rail ซ่อนข้อความนี้ด้วย CSS (sr-only) — อีเมล/role ยังอ่านได้โดย screen reader */}
            <div className="storeos-sidebar-label min-w-0">
              <p className="truncate text-sm font-bold text-[var(--ink)]">{user.email}</p>
              <p className="text-xs capitalize text-[var(--muted)]">{storeContext?.role ?? "user"}</p>
            </div>
          </div>
          <form action={signOut}>
            {/* tablet rail: ปุ่ม icon-only ต้องมี aria-label + tooltip (Design System v1 §5) */}
            <SubmitButton
              variant="secondary"
              className="w-full text-xs"
              aria-label="ออกจากระบบ"
              title="ออกจากระบบ"
            >
              <span aria-hidden="true" className="storeos-sidebar-signout-icon">
                ⏻
              </span>
              <span className="storeos-sidebar-label">ออกจากระบบ</span>
            </SubmitButton>
          </form>
        </div>
      </aside>

      <div className="storeos-main">
        <header className="topbar gap-3">
          <div className="min-w-0">
            <div className="page-title">ระบบจัดการร้าน</div>
            <div className="page-kicker truncate">
              {storeContext
                ? `${storeContext.storeName} · ${storeContext.role}`
                : "ไม่มีร้านค้า — โปรดติดต่อผู้ดูแลระบบ"}
            </div>
          </div>
          <div className="flex-1" />
          {storeContext && (
            <span className="badge badge-brand hidden sm:inline-flex">
              {storeContext.orgName}
            </span>
          )}
          <span className="badge badge-success hidden sm:inline-flex">เชื่อมต่อปกติ</span>
          {/* บนมือถือแถบข้างถูกซ่อน (hidden md:flex) ปุ่มออกจากระบบที่อยู่ในนั้นจึง
              เข้าไม่ถึงเลย — แถบล่างมีแต่รายการเมนู จึงต้องมีทางออกตรงนี้ */}
          <form action={signOut} className="md:hidden">
            <SubmitButton variant="secondary" className="whitespace-nowrap text-xs">
              ออกจากระบบ
            </SubmitButton>
          </form>
        </header>
        {stores.length > 1 && (
          <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 md:hidden">
            <StoreSwitcher stores={stores} currentStoreId={storeContext.storeId} />
          </div>
        )}
        <main className="scroll-area">{children}</main>
        <nav className="shrink-0 overflow-x-auto border-t border-[var(--border)] bg-[var(--surface)] md:hidden">
          <SideNav items={navItems} orientation="horizontal" />
        </nav>
      </div>
      <CommandPalette commands={commandItems} />
      <PushTokenRegistrar />
      {can("reports.view") && <NotificationGlobalNotifier storeId={storeContext.storeId} />}
      <QrOrderGlobalNotifier
        storeId={storeContext.storeId}
        storeName={storeContext.storeName}
        qrOrderingEnabled={qrOrderingEnabled}
        canManageQr={canManageQr}
        canViewEveryKitchenStation={storeContext.role !== "staff"}
        assignedKitchenStationIds={assignedKitchenStationIds}
        stationPrinters={stationPrinters}
        autoPrintStationTickets={autoPrintStationTickets}
        receiptPaperWidth={receiptPaperWidth}
        receiptPrinters={receiptPrinters}
      />
      <DeliveryGlobalNotifier
        storeId={storeContext.storeId}
        canManage={canManageQr}
        storeName={storeContext.storeName}
        stationPrinters={deliveryStationPrinters}
        paperWidth={receiptPaperWidth}
        printers={receiptPrinters}
        autoPrintOnArrival={autoPrintStationTickets}
      />
    </div>
  );
}
