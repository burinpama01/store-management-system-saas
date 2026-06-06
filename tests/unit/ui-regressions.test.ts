import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("UX/UI regression guards", () => {
  it("dashboard shell defines a mobile navigation path", () => {
    const source = read("src/app/(dashboard)/layout.tsx");

    expect(source).toContain("md:hidden");
    expect(source).toContain("hidden md:flex");
  });

  it("POS shell stacks cart and catalog on narrow screens", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("lg:flex-row");
    expect(source).toContain("lg:w-72");
  });

  it("QR ordering keeps primary touch controls at least 44px high", () => {
    const source = read("src/app/qr/[storeSlug]/[tableId]/QrOrderingApp.tsx");

    expect(source).toContain("min-h-11");
    expect(source).toContain("min-w-11");
    expect(source).toContain("aria-label");
    expect(source).toContain("min-h-11 flex items-center justify-between");
    expect(source).toContain("w-full min-h-11 py-3 rounded-xl");
  });

  it("mobile dashboard navigation uses touch-sized targets", () => {
    const source = read("src/shared/components/SideNav.tsx");

    expect(source).toContain("min-h-11");
  });

  it("POS narrow controls include touch-sized classes", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("min-h-11");
    expect(source).toContain("min-w-11");
  });

  it("shared table uses static Tailwind alignment classes", () => {
    const source = read("src/shared/components/ui/Table.tsx");

    expect(source).toContain("ALIGN_CLASS");
    expect(source).not.toContain("text-${col.align");
  });

  it("POS internal navigation uses next/link", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain('import Link from "next/link"');
    expect(source).not.toContain('<a href="/"');
  });

  it("POS payment retry reuses the created order after payment failure", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("pendingOrder");
    expect(source).toContain("if (!order) {");
    expect(source).toContain("setPendingOrder(order)");
    expect(source).toContain("collectPaymentAction(order.orderId");
    expect(source).toContain("hasPendingOrder");
    expect(source).toContain("const cartLocked = phase !== \"ordering\" || pendingOrder !== null");
    expect(source).toContain("if (cartLocked) return");
    expect(source).toContain("กรุณาชำระเงินให้จบก่อนแก้ไขตะกร้า");
  });

  it("POS modifier picker supports multiple options per modifier group", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("selectedModifiers: Record<string, ModifierOption[]>");
    expect(source).toContain("flatMap(([groupId, options])");
    expect(source).toContain("group.selectionType === \"single\"");
    expect(source).toContain("current.length >= group.maxSelections");
  });

  it("dashboard root redirects non-dashboard users to a first allowed route", () => {
    const source = read("src/app/(dashboard)/page.tsx");

    expect(source).toContain("firstAllowedRoute");
    expect(source).toContain('{ permission: "pos.use", href: "/pos" }');
    expect(source).not.toContain('if (!resolved.can("dashboard.view")) redirect("/")');
  });

  it("team settings hides platform-only controls from non-super-admin actors", () => {
    const source = read("src/app/(dashboard)/settings/team/TeamSettings.tsx");
    const pageSource = read("src/app/(dashboard)/settings/team/page.tsx");

    expect(source).toContain("canManagePlatform");
    expect(source).toContain("availableRoles");
    expect(source).toContain("platformPermissions");
    expect(pageSource).toContain("getResolvedCurrentPermissions");
    expect(pageSource).toContain('resolved.can("settings.view")');
    expect(pageSource).not.toContain("resolvePermissions(ctx.role, [],");
  });

  it("settings layout respects permission overrides instead of role defaults only", () => {
    const source = read("src/app/(dashboard)/settings/layout.tsx");
    const teamActions = read("src/app/(dashboard)/settings/team/actions.ts");

    expect(source).toContain("getResolvedCurrentPermissions");
    expect(source).toContain('resolved.can("settings.view")');
    expect(source).not.toContain("resolvePermissions(ctx.role, [],");
    expect(source).not.toContain("memberships.find(");
    expect(teamActions).toContain("getResolvedCurrentPermissions");
    expect(teamActions).not.toContain("memberships.find(");
    expect(teamActions).not.toContain("resolvePermissions(");
  });

  it("shared form controls, buttons, and settings tabs use touch-sized targets", () => {
    const globalCss = read("src/app/globals.css");
    const settingsNav = read("src/app/(dashboard)/settings/SettingsNav.tsx");

    expect(globalCss).toContain("min-height: 2.75rem");
    expect(settingsNav).toContain("min-h-11");
    expect(settingsNav).not.toContain("min-h-9");
  });

  it("auth feedback messages expose accessible live regions", () => {
    const login = read("src/app/(auth)/login/page.tsx");
    const reset = read("src/app/(auth)/reset-password/page.tsx");
    const update = read("src/app/update-password/page.tsx");
    const globalCss = read("src/app/globals.css");

    expect(login).toContain('className="alert-danger" role="alert"');
    expect(reset).toContain('className="alert-danger" role="alert"');
    expect(reset).toContain('className="alert-success" aria-live="polite"');
    expect(update).toContain('className="alert-danger" role="alert"');
    expect(globalCss).toContain(".auth-card");
    expect(globalCss).toContain("width: calc(100% - 4rem)");
    expect(globalCss).toContain("max-width: 28rem");
    expect(globalCss).toContain("min-width: 0");
    expect(login).toContain("auth-card");
    expect(reset).toContain("auth-card");
    expect(update).toContain("auth-card");
  });

  it("dashboard and reports tables can scroll horizontally on narrow screens", () => {
    const dashboard = read("src/app/(dashboard)/page.tsx");
    const reports = read("src/app/(dashboard)/reports/ReportsManager.tsx");

    expect(dashboard).toContain("overflow-x-auto");
    expect(dashboard).toContain("min-w-[520px]");
    expect(reports).toContain("overflow-x-auto");
    expect(reports).toContain("min-w-[520px]");
  });

  it("mobile dashboard header guards long store names from overlap", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");
    const storeSwitcher = read("src/shared/components/store-switcher.tsx");

    expect(layout).toContain("gap-3");
    expect(layout).toContain("min-w-0");
    expect(storeSwitcher).toContain("min-w-0");
    expect(storeSwitcher).toContain("max-w-full");
  });

  it("billing routes use billing.manage as the authorization source of truth", () => {
    const sources = [
      read("src/app/api/stripe/checkout/route.ts"),
      read("src/app/api/stripe/portal/route.ts"),
    ].join("\n");

    expect(sources).toContain('requirePermission("billing.manage")');
    expect(sources).not.toContain('ctx.role !== "owner"');
  });

  it("primary UI surfaces avoid mixed English operational copy", () => {
    const sources = [
      read("src/app/(auth)/login/page.tsx"),
      read("src/app/(auth)/reset-password/page.tsx"),
      read("src/app/update-password/page.tsx"),
      read("src/app/(dashboard)/layout.tsx"),
      read("src/app/qr/[storeSlug]/[tableId]/QrOrderingApp.tsx"),
      read("src/modules/printing/adapters/browser.ts"),
    ].join("\n");

    for (const phrase of [
      "Sign in",
      "Sign out",
      'label: "Dashboard"',
      ">Dashboard<",
      "All",
      "Size / Type",
      "Note (optional)",
      "Add to Order",
      "Your Order",
      "Submit Order",
      "Order Placed!",
      "Menu has changed",
      "Tel:",
      "Tax ID:",
      "Order:",
      "Table:",
      "Subtotal",
      "** TOTAL **",
      "Cash",
      "Received",
      "  Change",
      "Pop-up blocked",
      "Account recovery",
      "Password setup",
    ]) {
      expect(sources).not.toContain(phrase);
    }
  });

  it("login accepts Supabase invite hash tokens", () => {
    const source = read("src/app/(auth)/login/page.tsx");

    expect(source).toContain("access_token");
    expect(source).toContain("refresh_token");
    expect(source).toContain("setSession");
    expect(source).toContain('sessionStorage.setItem("password_setup_intent", "invite")');
    expect(source).toContain("window.history.replaceState");
    expect(source).toContain('router.replace("/update-password")');
    expect(source).toContain(".catch");
  });

  it("login server action does not log Supabase error messages in production", () => {
    const source = read("src/app/(auth)/login/actions.ts");
    const productionBranch = source.split('process.env.NODE_ENV === "production"')[1]?.split("return;")[0] ?? "";

    expect(source).toContain("process.env.NODE_ENV");
    expect(source).toContain("logSignInError");
    expect(productionBranch).toContain("error.code");
    expect(productionBranch).not.toContain("error.message");
  });

  it("invite flow provides a password setup screen", () => {
    const source = read("src/app/update-password/page.tsx");
    const authLayout = read("src/app/(auth)/layout.tsx");
    const middleware = read("src/server/integrations/supabase/middleware.ts");

    expect(source).toContain("access_token");
    expect(source).toContain("refresh_token");
    expect(source).toContain("setSession");
    expect(source).toContain("canUpdatePassword");
    expect(source).toContain("password_setup_intent");
    expect(source).toContain('sessionStorage.setItem("password_setup_intent", "recovery")');
    expect(source).toContain('sessionStorage.removeItem("password_setup_intent")');
    expect(source).toContain('router.replace("/")');
    expect(source).toContain("updateUser");
    expect(source).toContain(".getUser");
    expect(source).toContain("password");
    expect(source).toContain("confirmPassword");
    expect(source).toContain("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
    expect(source).toContain('router.replace("/login")');
    expect(source).toContain("router.replace(\"/\")");
    expect(authLayout).not.toContain("update-password");
    expect(middleware).toContain('startsWith("/update-password")');
  });

  it("reset password flow is reachable and points recovery links to password setup", () => {
    const login = read("src/app/(auth)/login/page.tsx");
    const reset = read("src/app/(auth)/reset-password/page.tsx");
    const middleware = read("src/server/integrations/supabase/middleware.ts");

    expect(login).toContain('href="/reset-password"');
    expect(reset).toContain("resetPasswordForEmail");
    expect(reset).toContain('redirectTo: `${window.location.origin}/update-password`');
    expect(reset).toContain('href="/login"');
    expect(middleware).toContain('startsWith("/reset-password")');
  });

  it("password recovery submit handlers fail closed on rejected Supabase calls", () => {
    const reset = read("src/app/(auth)/reset-password/page.tsx");
    const update = read("src/app/update-password/page.tsx");
    const resetSubmit = reset.split("async function handleSubmit")[1]?.split("\n  return (")[0] ?? "";
    const updateSubmit = update.split("async function handleSubmit")[1]?.split("\n  return (")[0] ?? "";

    expect(resetSubmit).toContain("try {");
    expect(resetSubmit).toContain("catch");
    expect(resetSubmit).toContain("finally");
    expect(resetSubmit).toContain("setIsPending(false)");
    expect(updateSubmit).toContain("try {");
    expect(updateSubmit).toContain("catch");
    expect(updateSubmit).toContain("finally");
    expect(updateSubmit).toContain("setIsPending(false)");
  });

  it("super admin reset script fails closed when reset email fails", () => {
    const source = read("scripts/reset-super-admin.mjs");

    expect(source).toContain("reset email failed; rolled back created user");
    expect(source).toContain('from("memberships").delete().eq("user_id", created.user.id)');
    expect(source).toContain("auth.admin.deleteUser(created.user.id)");
    expect(source).not.toContain("resetEmailSent: !resetError");
  });

  it("catalog workbench exposes role, plan, images, and package locks", () => {
    const page = read("src/app/(dashboard)/catalog/page.tsx");
    const source = read("src/app/(dashboard)/catalog/CatalogManager.tsx");

    expect(page).toContain("getPlanFeatures");
    expect(page).toContain("canManageCatalog");
    expect(source).toContain("Catalog Workbench");
    expect(source).toContain("RoleCapabilityBar");
    expect(source).toContain("URL รูปเมนู");
    expect(source).toContain("ProductImage");
    expect(source).toContain("QR Ordering ถูกล็อกตามแพ็กเกจ");
    expect(source).toContain("โหมดอ่านอย่างเดียวสำหรับ role นี้");
  });

  it("catalog add and edit flows open in a dialog instead of a side panel", () => {
    const source = read("src/app/(dashboard)/catalog/CatalogManager.tsx");
    const dialog = read("src/shared/components/ui/ModalDialog.tsx");

    expect(dialog).toContain("role=\"dialog\"");
    expect(dialog).toContain("aria-modal=\"true\"");
    expect(dialog).toContain("fixed inset-0 z-50");
    expect(dialog).toContain("onClick={onClose}");
    expect(dialog).toContain("dialogRef");
    expect(dialog).toContain("lastFocusedElementRef");
    expect(dialog).toContain("focusableSelectors");
    expect(dialog).toContain("event.key !== \"Tab\"");
    expect(dialog).toContain("lastFocusedElementRef.current?.focus()");
    expect(dialog).toContain("tabIndex={-1}");
    expect(source).not.toContain("w-80 shrink-0 border-l border-gray-200");
    expect(source).toContain("<ModalDialog");
  });

  it("dashboard add and edit forms use dialogs across pages", () => {
    const accounting = read("src/app/(dashboard)/accounting/AccountingManager.tsx");
    const buffet = read("src/app/(dashboard)/buffet/BuffetManager.tsx");
    const attendance = read("src/app/(dashboard)/attendance/AttendanceManager.tsx");
    const store = read("src/app/(dashboard)/settings/store/StoreSettingsForm.tsx");
    const receipt = read("src/app/(dashboard)/settings/receipt/ReceiptSettingsForm.tsx");

    expect(accounting).toContain("<ModalDialog");
    expect(accounting).toContain("entryDialogOpen");
    expect(accounting).toContain("function AccountingEntryDialog");
    expect(accounting).toContain("{entryDialogOpen && (");
    expect(accounting).not.toContain("Quick-add form (left column)");

    expect(buffet).toContain("<ModalDialog");
    expect(buffet).toContain("sessionDialogOpen");
    expect(buffet).toContain("guestDialogSession");
    expect(buffet).toContain("function BuffetSessionDialog");
    expect(buffet).toContain("function BuffetGuestCountDialog");
    expect(buffet).toContain("แก้ไขจำนวนคน");
    expect(buffet).not.toContain('value={guestEdit}');
    expect(buffet).not.toContain("Start new session form");

    expect(attendance).toContain("<ModalDialog");
    expect(attendance).toContain("attendanceSettingsDialogOpen");
    expect(attendance).toContain("function AttendanceSettingsDialog");
    expect(attendance).toContain("{attendanceSettingsDialogOpen && (");
    expect(attendance).toContain("แก้ไข GPS เข้างาน");

    expect(store).toContain("<ModalDialog");
    expect(store).toContain("storeDialogOpen");
    expect(store).toContain("function StoreSettingsDialog");
    expect(store).toContain("{storeDialogOpen && (");
    expect(store).toContain("แก้ไขข้อมูลร้าน");

    expect(receipt).toContain("<ModalDialog");
    expect(receipt).toContain("receiptDialogOpen");
    expect(receipt).toContain("function ReceiptSettingsDialog");
    expect(receipt).toContain("{receiptDialogOpen && (");
    expect(receipt).toContain("แก้ไขตั้งค่าใบเสร็จ");
  });

  it("dashboard route access guards use the same permission source as navigation", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");
    const pages = {
      dashboard: read("src/app/(dashboard)/page.tsx"),
      catalog: read("src/app/(dashboard)/catalog/page.tsx"),
      stock: read("src/app/(dashboard)/stock/page.tsx"),
      pos: read("src/app/pos/page.tsx"),
      accounting: read("src/app/(dashboard)/accounting/page.tsx"),
      reports: read("src/app/(dashboard)/reports/page.tsx"),
      attendance: read("src/app/(dashboard)/attendance/page.tsx"),
      buffet: read("src/app/(dashboard)/buffet/page.tsx"),
      storeSettings: read("src/app/(dashboard)/settings/store/page.tsx"),
      receiptSettings: read("src/app/(dashboard)/settings/receipt/page.tsx"),
      teamSettings: read("src/app/(dashboard)/settings/team/page.tsx"),
      diagnostics: read("src/app/(dashboard)/settings/diagnostics/page.tsx"),
      notifications: read("src/app/(dashboard)/settings/notifications/page.tsx"),
    };

    const navPermissions = [
      'can("dashboard.view")',
      'can("catalog.view")',
      'can("stock.manage")',
      'can("pos.use")',
      'can("cashflow.view")',
      'can("reports.view")',
      'can("attendance.clock")',
      'can("orders.manage_qr")',
      'can("settings.view")',
    ];
    for (const permission of navPermissions) {
      expect(layout).toContain(permission);
    }

    expect(pages.dashboard).toContain('resolved.can("dashboard.view")');
    expect(pages.catalog).toContain('resolved.can("catalog.view")');
    expect(pages.stock).toContain('requirePermission("stock.manage")');
    expect(pages.pos).toContain('requirePermission("pos.use")');
    expect(pages.accounting).toContain('resolved.can("cashflow.view")');
    expect(pages.reports).toContain('resolved.can("reports.view")');
    expect(pages.attendance).toContain('resolved.can("attendance.clock")');
    expect(pages.buffet).toContain('resolved.can("orders.manage_qr")');
    expect(pages.buffet).toContain("buffet_enabled");
    expect(pages.storeSettings).toContain('resolved.can("settings.view")');
    expect(pages.receiptSettings).toContain('resolved.can("settings.view")');
    expect(pages.teamSettings).toContain('resolved.can("settings.view")');
    expect(pages.diagnostics).toContain('resolved.can("settings.view")');
    expect(pages.notifications).toContain('resolved.can("settings.view")');

    for (const [name, source] of Object.entries(pages)) {
      if (name === "stock" || name === "pos") continue;
      expect(source, name).toContain("getResolvedCurrentPermissions");
      expect(source, name).not.toContain("resolvePermissions(ctx.role, [],");
    }
  });

  it("dashboard page layouts keep responsive shells, scrollable data, and stable dialog surfaces", () => {
    const sources = {
      dashboard: read("src/app/(dashboard)/page.tsx"),
      catalog: read("src/app/(dashboard)/catalog/CatalogManager.tsx"),
      stock: read("src/app/(dashboard)/stock/page.tsx"),
      accounting: read("src/app/(dashboard)/accounting/AccountingManager.tsx"),
      reports: read("src/app/(dashboard)/reports/ReportsManager.tsx"),
      attendance: read("src/app/(dashboard)/attendance/AttendanceManager.tsx"),
      buffet: read("src/app/(dashboard)/buffet/BuffetManager.tsx"),
      settingsNav: read("src/app/(dashboard)/settings/SettingsNav.tsx"),
    };

    expect(sources.dashboard).toContain("overflow-x-auto");
    expect(sources.dashboard).toContain("min-w-[520px]");
    expect(sources.catalog).toContain("lg:grid-cols-[260px_minmax(0,1fr)]");
    expect(sources.catalog).toContain("overflow-x-auto");
    expect(sources.catalog).toContain("min-h-11");
    expect(sources.stock).toContain("overflow-x-auto");
    expect(sources.stock).toContain("min-w-[720px]");
    expect(sources.accounting).toContain("xl:grid-cols-3");
    expect(sources.accounting).toContain("<ModalDialog");
    expect(sources.reports).toContain("page-shell");
    expect(sources.reports).toContain("xl:grid-cols-2");
    expect(sources.reports).toContain("overflow-x-auto");
    expect(sources.attendance).toContain("overflow-x-auto");
    expect(sources.attendance).toContain("min-w-[640px]");
    expect(sources.attendance).toContain("<ModalDialog");
    expect(sources.buffet).toContain("xl:grid-cols-3");
    expect(sources.buffet).toContain("<ModalDialog");
    expect(sources.settingsNav).toContain("min-h-11");
  });

  it("catalog delete paths keep store-boundary checks", () => {
    const actions = read("src/app/(dashboard)/catalog/actions.ts");
    const repository = read("src/modules/catalog/repository.ts");

    expect(actions).toContain("deleteCategory(id, ctx.storeId)");
    expect(actions).toContain("deleteProduct(id, ctx.storeId)");
    expect(actions).toContain("deleteVariant(id, ctx.storeId)");
    expect(actions).toContain("deleteModifierGroup(id, ctx.storeId)");
    expect(actions).toContain("deleteModifierOption(id, ctx.storeId)");

    expect(repository).toContain('from("categories").delete().eq("id", id).eq("store_id", storeId)');
    expect(repository).toContain('from("products").delete().eq("id", id).eq("store_id", storeId)');
    expect(repository).toContain('select("store_id")');
    expect(repository).toContain('if (!product || product.store_id !== storeId)');
    expect(repository).toContain("ไม่มีสิทธิ์");
  });

  it("POS product tiles reserve image space for menu photos", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("PosProductImage");
    expect(source).toContain("aspect-[4/3]");
    expect(source).toContain("loading=\"lazy\"");
    expect(source).toContain("รูปเมนู");
  });

  it("settings diagnostics includes safe test buttons", () => {
    const nav = read("src/app/(dashboard)/settings/SettingsNav.tsx");
    const page = read("src/app/(dashboard)/settings/diagnostics/page.tsx");
    const panel = read("src/app/(dashboard)/settings/diagnostics/DiagnosticsPanel.tsx");

    expect(nav).toContain("/settings/diagnostics");
    expect(page).toContain("settings.view");
    expect(panel).toContain("เทส notifications");
    expect(panel).toContain("เทสปริ้นใบเสร็จ");
    expect(panel).toContain("เทส QR PromptPay");
    expect(panel).toContain("เทสเครื่องปริ้น");
    expect(panel).toContain("ไม่สร้าง order/payment จริง");
  });

  it("settings notifications exposes event/channel matrix without secrets", () => {
    const nav = read("src/app/(dashboard)/settings/SettingsNav.tsx");
    const page = read("src/app/(dashboard)/settings/notifications/page.tsx");

    expect(nav).toContain("/settings/notifications");
    expect(page).toContain("notifications.manage");
    expect(page).toContain("getPlanFeatures");
    expect(page).toContain("features.lineNotify");
    expect(page).toContain("NOTIFICATION_TYPES");
    expect(page).toContain("NOTIFICATION_CHANNELS");
    expect(page).toContain("ไม่แสดง token หรือ secret");
  });

  it("public QR ordering is gated by package on page and submit action", () => {
    const page = read("src/app/qr/[storeSlug]/[tableId]/page.tsx");
    const action = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");

    expect(page).toContain("getOrganizationBillingState");
    expect(page).toContain("getPlanFeatures");
    expect(page).toContain("features.qrOrdering");
    expect(page).toContain("แพ็กเกจของร้านนี้ยังไม่เปิดใช้ QR Ordering");
    expect(action).toContain("getOrganizationBillingState");
    expect(action).toContain("getPlanFeatures");
    expect(action).toContain("features.qrOrdering");
    expect(action).toContain("QR ordering is not available in the current package");
  });

  it("stock page is navigable and package-gated", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");
    const page = read("src/app/(dashboard)/stock/page.tsx");

    expect(layout).toContain('href: "/stock"');
    expect(page).toContain('requirePermission("stock.manage")');
    expect(page).toContain("getPlanFeatures");
    expect(page).toContain("features.stockManagement");
    expect(page).toContain("แจ้งเตือนสต็อกต่ำ");
    expect(page).toContain("listLowStockAlerts");
  });

  it("dashboard sidebar separates navigation by role permissions", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");

    expect(layout).toContain("getResolvedCurrentPermissions");
    expect(layout).toContain('can("catalog.view")');
    expect(layout).toContain('can("stock.manage")');
    expect(layout).toContain('can("pos.use")');
    expect(layout).toContain('can("settings.view")');
  });

  it("dashboard KPI queries require dashboard.view before loading sensitive metrics", () => {
    const source = read("src/app/(dashboard)/page.tsx");
    const guardIndex = source.indexOf('resolved.can("dashboard.view")');
    const dashboardQueryIndex = source.indexOf("getDashboardData(ctx.storeId)");
    const cashQueryIndex = source.indexOf("getLatestCashBalance(ctx.storeId)");

    expect(source).toContain('import { getResolvedCurrentPermissions } from "@/modules/auth/guards"');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(dashboardQueryIndex).toBeGreaterThan(guardIndex);
    expect(cashQueryIndex).toBeGreaterThan(guardIndex);
  });

  it("dashboard and reports pages use resolved permissions with overrides", () => {
    const dashboard = read("src/app/(dashboard)/page.tsx");
    const reports = read("src/app/(dashboard)/reports/page.tsx");

    expect(dashboard).toContain("getResolvedCurrentPermissions");
    expect(dashboard).not.toContain("resolvePermissions(ctx.role, [],");
    expect(reports).toContain("getResolvedCurrentPermissions");
    expect(reports).toContain('resolved.can("reports.view")');
    expect(reports).not.toContain("resolvePermissions(ctx.role, [],");
  });

  it("attendance GPS capture is package-gated while attendance remains usable", () => {
    const page = read("src/app/(dashboard)/attendance/page.tsx");
    const actions = read("src/app/(dashboard)/attendance/actions.ts");
    const manager = read("src/app/(dashboard)/attendance/AttendanceManager.tsx");

    expect(page).toContain("getPlanFeatures");
    expect(page).toContain("canUseGps={features.attendanceGps}");
    expect(actions).toContain("getPlanFeatures");
    expect(actions).toContain("features.attendanceGps");
    expect(actions).toContain("locationAllowed");
    expect(manager).toContain("canUseGps");
    expect(manager).toContain("GPS ถูกจำกัดตามแพ็กเกจ");
  });

  it("store feature toggles are package-gated in UI and server action", () => {
    const page = read("src/app/(dashboard)/settings/store/page.tsx");
    const form = read("src/app/(dashboard)/settings/store/StoreSettingsForm.tsx");
    const actions = read("src/app/(dashboard)/settings/store/actions.ts");

    expect(page).toContain("getPlanFeatures");
    expect(page).toContain("canUseQrOrdering");
    expect(page).toContain("canUseBuffet");
    expect(form).toContain("canUseQrOrdering");
    expect(form).toContain("QR Ordering ถูกจำกัดตามแพ็กเกจ");
    expect(actions).toContain("getPlanFeatures");
    expect(actions).toContain("features.qrOrdering");
    expect(actions).toContain("features.buffetManagement");
  });
});
