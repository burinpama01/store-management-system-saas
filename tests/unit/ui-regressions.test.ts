import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("UX/UI regression guards", () => {
  it("publishes public app privacy policy and terms pages", () => {
    const legalPagePath = "src/app/(legal)/LegalPage.tsx";
    const privacyPath = "src/app/(legal)/privacy-policy/page.tsx";
    const termsPath = "src/app/(legal)/terms-of-service/page.tsx";
    const middleware = read("src/server/integrations/supabase/middleware.ts");
    const shell = read("src/shared/components/marketing/MarketingShell.tsx");
    const globals = read("src/app/globals.css");

    expect(existsSync(join(root, privacyPath))).toBe(true);
    expect(existsSync(join(root, termsPath))).toBe(true);

    const legalPage = read(legalPagePath);
    const privacy = read(privacyPath);
    const terms = read(termsPath);
    const legalSurface = [legalPage, privacy, terms, shell].join("\n");

    expect(legalPage).toContain("เอกสารนี้เป็นข้อมูลของแอป StoreOS");
    expect(legalSurface).not.toContain("LINE Official Account Manager");
    expect(legalSurface).not.toContain("กรอกใน LINE");

    expect(privacy).toContain("นโยบายความเป็นส่วนตัว");
    expect(privacy).toContain("LINE Official Account");
    expect(privacy).toContain("line_user_id");
    expect(privacy).toContain("support@storeos.app");
    expect(privacy).toContain("ติดต่อ support@storeos.app เพื่อขอยกเลิก");
    expect(privacy).not.toContain("ยกเลิกการผูก LINE ได้จากหน้าตั้งค่าการแจ้งเตือน");
    expect(privacy).not.toContain("redirect(\"/login\")");

    expect(terms).toContain("ข้อกำหนดการใช้บริการ");
    expect(terms).toContain("LINE Official Account");
    expect(terms).toContain("การแจ้งเตือน");
    expect(terms).toContain("support@storeos.app");
    expect(terms).toContain("ติดต่อ support@storeos.app เพื่อขอยกเลิก");
    expect(terms).not.toContain("ยกเลิกการเชื่อมต่อ LINE จากหน้าตั้งค่าการแจ้งเตือน");
    expect(terms).not.toContain("redirect(\"/login\")");

    expect(middleware).toContain('request.nextUrl.pathname === "/privacy-policy"');
    expect(middleware).toContain('request.nextUrl.pathname === "/terms-of-service"');

    expect(shell).toContain('href="/privacy-policy"');
    expect(shell).toContain('href="/terms-of-service"');
    expect(shell).toContain("นโยบายความเป็นส่วนตัว");
    expect(shell).toContain("ข้อกำหนดการใช้บริการ");
    expect(globals).toContain(".marketing-footer-links");
  });

  it("dashboard shell defines a mobile navigation path", () => {
    const source = read("src/app/(dashboard)/layout.tsx");

    expect(source).toContain("md:hidden");
    expect(source).toContain("hidden md:flex");
  });

  it("POS shell stacks cart and catalog on narrow screens", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("lg:flex-row");
    expect(source).toContain("lg:w-80");
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
    const source = read("src/app/(dashboard)/dashboard/page.tsx");

    expect(source).toContain("firstAllowedRoute");
    expect(source).toContain('{ permission: "pos.use", href: "/pos" }');
    expect(source).toContain('{ permission: "catalog.manage", href: "/catalog" }');
    expect(source).not.toContain('{ permission: "catalog.view", href: "/catalog" }');
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
    const dashboard = read("src/app/(dashboard)/dashboard/page.tsx");
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

    // Recovery/invite tokens (hash #access_token or ?code) are auto-processed by
    // @supabase/ssr (detectSessionInUrl) and surfaced via onAuthStateChange.
    expect(source).toContain("onAuthStateChange");
    expect(source).toContain("PASSWORD_RECOVERY");
    expect(source).toContain("canUpdatePassword");
    expect(source).toContain("updateUser");
    expect(source).toContain(".getUser");
    expect(source).toContain("password");
    expect(source).toContain("confirmPassword");
    expect(source).toContain("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
    // Fails closed to login when no recovery/session is established.
    expect(source).toContain('router.replace("/login")');
    // On success the user lands in the app, not the public landing page.
    expect(source).toContain('router.replace("/dashboard")');
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
    expect(source).toContain("ImageUpload");
    expect(source).toContain('name="imageUrl"');
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
      dashboard: read("src/app/(dashboard)/dashboard/page.tsx"),
      catalog: read("src/app/(dashboard)/catalog/page.tsx"),
      stock: read("src/app/(dashboard)/stock/page.tsx"),
      pos: read("src/app/pos/page.tsx"),
      accounting: read("src/app/(dashboard)/accounting/page.tsx"),
      accountingActions: read("src/app/(dashboard)/accounting/actions.ts"),
      accountingManager: read("src/app/(dashboard)/accounting/AccountingManager.tsx"),
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
      'can("catalog.manage")',
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
    expect(pages.catalog).toContain('resolved.can("catalog.manage")');
    expect(pages.stock).toContain('requirePermission("stock.manage")');
    expect(pages.pos).toContain('resolved.can("pos.use")');
    expect(pages.accounting).toContain('resolved.can("cashflow.view")');
    expect(pages.accounting).toContain('resolved.can("cashflow.record")');
    expect(pages.accountingActions).toContain('requirePermission("cashflow.record")');
    expect(pages.accountingActions).toContain('requirePermission("cashflow.manage")');
    expect(pages.accountingActions).toContain('type === "cash_adjustment" && !canManageCashflow');
    expect(pages.accountingManager).toContain('{canManage && <option value="cash_adjustment">ปรับเงินสด</option>}');
    expect(pages.reports).toContain('resolved.can("reports.view")');
    expect(pages.attendance).toContain('resolved.can("attendance.clock")');
    expect(pages.buffet).toContain('resolved.can("orders.manage_qr")');
    expect(pages.buffet).toContain("buffet_enabled");
    expect(pages.storeSettings).toContain('resolved.can("settings.view")');
    expect(pages.receiptSettings).toContain('resolved.can("settings.view")');
    expect(pages.receiptSettings).toContain('resolved.can("settings.manage_printer")');
    expect(pages.teamSettings).toContain('resolved.can("settings.view")');
    expect(pages.diagnostics).toContain('resolved.can("settings.view")');
    expect(pages.notifications).toContain('resolved.can("settings.view")');

    for (const [name, source] of Object.entries(pages)) {
      if (name === "stock" || name === "accountingManager") continue;
      expect(source, name).toContain("getResolvedCurrentPermissions");
      expect(source, name).not.toContain("resolvePermissions(ctx.role, [],");
    }
  });

  it("dashboard page layouts keep responsive shells, scrollable data, and stable dialog surfaces", () => {
    const sources = {
      dashboard: read("src/app/(dashboard)/dashboard/page.tsx"),
      catalog: read("src/app/(dashboard)/catalog/CatalogManager.tsx"),
      stock: read("src/app/(dashboard)/stock/StockManager.tsx"),
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

  it("settings test buttons live in their respective tabs (no combined diagnostics tab)", () => {
    const nav = read("src/app/(dashboard)/settings/SettingsNav.tsx");
    const notifPage = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const notifTest = read("src/app/(dashboard)/settings/notifications/NotificationTest.tsx");
    const receiptPage = read("src/app/(dashboard)/settings/receipt/page.tsx");
    const receiptTests = read("src/app/(dashboard)/settings/receipt/ReceiptTests.tsx");

    // The combined diagnostics tab is removed; tests live in their own tabs.
    expect(nav).not.toContain("/settings/diagnostics");

    expect(notifPage).toContain("NotificationTest");
    expect(notifTest).toContain("runTelegramNotificationTestAction");

    expect(receiptPage).toContain("ReceiptTests");
    expect(receiptTests).toContain("ทดสอบพิมพ์ใบเสร็จ");
    expect(receiptTests).toContain("ทดสอบ QR PromptPay");
    expect(receiptTests).toContain("ทดสอบเครื่องพิมพ์");
  });

  it("settings notifications exposes event/channel matrix without secrets", () => {
    const layout = read("src/app/(dashboard)/settings/layout.tsx");
    const page = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const notificationTest = read("src/app/(dashboard)/settings/notifications/NotificationTest.tsx");
    const visibleCopy = `${page}\n${notificationTest}`;

    expect(layout).toContain("/settings/notifications");
    expect(page).toContain("notifications.manage");
    expect(page).toContain("getPlanFeatures");
    expect(page).toContain("features.lineNotify");
    expect(page).toContain("NOTIFICATION_TYPES");
    expect(page).toContain("NOTIFICATION_CHANNELS");
    expect(page).toContain("แสดงเฉพาะช่องทางที่พร้อมใช้งาน");
    expect(visibleCopy).not.toContain(".env.local");
    expect(visibleCopy).not.toContain("Token ของ bot");
    expect(visibleCopy).not.toContain("bot token");
    expect(visibleCopy).not.toContain("token หรือ secret");
    expect(visibleCopy).not.toContain("สถานะพร้อมใช้งานของ provider");
  });

  it("billing QR panel uses the generated quote amount as the visible amount to pay", () => {
    const source = read("src/app/(dashboard)/settings/billing/BillingManager.tsx");

    expect(source).toContain("paymentQuote");
    expect(source).toContain("plan: PaidTier");
    expect(source).toContain("duration: BillingDuration");
    expect(source).toContain("const requestPlan = selectedPlan");
    expect(source).toContain("const requestDuration = duration");
    expect(source).toContain("try {");
    expect(source).toContain("finally {");
    expect(source).toContain("setBusy(false)");
    expect(source).toContain("fd.set(\"plan\", paymentQuote?.plan ?? selectedPlan)");
    expect(source).toContain("fd.set(\"duration\", paymentQuote?.duration ?? duration)");
    expect(source).toContain("try {\n      const res = await uploadWithProgress");
    expect(source).toContain("catch {\n      showError(\"ตรวจสลิปไม่สำเร็จ\");");
    expect(source).toContain("finally {\n      setUploadPhase(\"idle\");");
    expect(source).toContain("displayAmount");
    expect(source).toContain("ยอดที่ต้องโอน");
    expect(source).toContain("เครดิตจากแพ็กเกจเดิม");
    expect(source).toContain("promotionLabel");
    expect(source).toContain("setPaymentQuote(null)");
    expect(source).toContain("amount: res.amount");
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

    const manager = read("src/app/(dashboard)/stock/StockManager.tsx");
    expect(layout).toContain('href: "/stock"');
    expect(page).toContain('requirePermission("stock.manage")');
    expect(page).toContain("getPlanFeatures");
    expect(page).toContain("features.stockManagement");
    expect(page).toContain("StockManager");
    expect(manager).toContain("สต็อกสินค้า");
    expect(manager).toContain("setStockAction");
  });

  it("dashboard sidebar separates navigation by role permissions", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");

    expect(layout).toContain("getResolvedCurrentPermissions");
    expect(layout).toContain('can("catalog.manage")');
    expect(layout).toContain('can("stock.manage")');
    expect(layout).toContain('can("pos.use")');
    expect(layout).toContain('can("settings.view")');
  });

  it("settings tabs only expose functions the user can access", () => {
    const layout = read("src/app/(dashboard)/settings/layout.tsx");
    const nav = read("src/app/(dashboard)/settings/SettingsNav.tsx");
    const team = read("src/app/(dashboard)/settings/team/page.tsx");
    const tables = read("src/app/(dashboard)/settings/tables/page.tsx");
    const receipt = read("src/app/(dashboard)/settings/receipt/page.tsx");
    const buffet = read("src/app/(dashboard)/settings/buffet/page.tsx");
    const notifications = read("src/app/(dashboard)/settings/notifications/page.tsx");
    const teamSettings = read("src/app/(dashboard)/settings/team/TeamSettings.tsx");

    expect(layout).toContain("buildSettingsTabs");
    expect(layout).toContain('resolved.can("settings.manage_store")');
    expect(layout).toContain('resolved.can("settings.manage_printer")');
    expect(layout).toContain('resolved.can("billing.manage")');
    expect(layout).toContain('resolved.can("notifications.manage")');
    expect(layout).toContain('resolved.can("users.manage")');
    expect(layout).toContain("<SettingsNav tabs={settingsTabs}");
    expect(nav).toContain("tabs: SettingsTab[]");
    expect(nav).not.toContain("const TABS = [");
    expect(team).toContain('!resolved.can("users.manage") && !resolved.can("permissions.manage")');
    expect(tables).toContain('!resolved.can("settings.manage_store")');
    expect(receipt).toContain('!resolved.can("settings.manage_store") && !resolved.can("settings.manage_printer")');
    expect(buffet).toContain('!resolved.can("settings.manage_store")');
    expect(notifications).toContain('!resolved.can("notifications.manage")');
    expect(teamSettings).toContain('"cashflow.record"');
    expect(teamSettings).toContain('"settings.manage_printer"');
  });

  it("lower-than-admin users land on attendance before other functions when clock-in is due", () => {
    const guards = read("src/modules/auth/guards.ts");
    const layout = read("src/app/(dashboard)/layout.tsx");
    const dashboard = read("src/app/(dashboard)/dashboard/page.tsx");

    expect(guards).toContain("shouldStartAtAttendance");
    expect(guards).toContain("ROLE_RANK[ctx.role] >= ROLE_RANK.admin");
    expect(guards).toContain(".from(\"attendance_records\")");
    expect(guards).toContain(".from(\"store_holidays\")");
    expect(guards).toContain(".from(\"employee_profiles\")");
    expect(guards).toContain("getStoreLocalDate");
    expect(guards).toContain('return "/attendance"');
    expect(layout).toContain("shouldStartAtAttendance");
    expect(layout).toContain('path !== "/attendance"');
    expect(dashboard.indexOf("shouldStartAtAttendance")).toBeGreaterThanOrEqual(0);
    expect(dashboard.indexOf('redirect("/attendance")')).toBeLessThan(
      dashboard.indexOf("getDashboardData(ctx.storeId)"),
    );
  });

  it("dashboard KPI queries require dashboard.view before loading sensitive metrics", () => {
    const source = read("src/app/(dashboard)/dashboard/page.tsx");
    const guardIndex = source.indexOf("dashboard.view");
    const dashboardQueryIndex = source.indexOf("getDashboardData(ctx.storeId)");
    const cashQueryIndex = source.indexOf("getLatestCashBalance(ctx.storeId)");

    expect(source).toContain("getResolvedCurrentPermissions");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(dashboardQueryIndex).toBeGreaterThan(guardIndex);
    expect(cashQueryIndex).toBeGreaterThan(guardIndex);
  });

  it("dashboard and reports pages use resolved permissions with overrides", () => {
    const dashboard = read("src/app/(dashboard)/dashboard/page.tsx");
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

  it("public marketing pages share the glass and 3D visual system", () => {
    const shell = read("src/shared/components/marketing/MarketingShell.tsx");
    const showcase = read("src/shared/components/marketing/MarketingProductShowcase.tsx");
    const landingWorkflow = read("src/shared/components/marketing/LandingWorkflow.tsx");
    const landing = read("src/app/page.tsx");
    const pricing = read("src/app/pricing/page.tsx");
    const pricingPlans = read("src/app/pricing/PricingPlans.tsx");
    const login = read("src/app/(auth)/login/page.tsx");
    const css = read("src/app/globals.css");
    const nextConfig = read("next.config.ts");

    expect(shell).toContain("MarketingHeader");
    expect(shell).toContain("marketing-glass");
    const marketingHeaderBlock =
      Array.from(css.matchAll(/\.marketing-header \{[^}]*\}/g))
        .map((match) => match[0])
        .find((block) => block.includes("z-index: 30;")) ?? "";
    expect(marketingHeaderBlock).toContain("width: 100%;");
    expect(marketingHeaderBlock).toContain("margin: 0 0 1.45rem;");
    expect(showcase).toContain('aria-hidden="true"');
    expect(showcase).not.toContain("<picture");
    expect(showcase).not.toContain("storeos-hero-bg");
    expect(showcase).not.toContain("storeos-login-bg");
    expect(showcase).toContain("marketing-glass-card");
    expect(showcase).toContain("marketing-card-icon");
    // Hero/login render the photorealistic bitmap product render (not the procedural WebGL scene).
    expect(showcase).toContain("marketing-product-bg");
    expect(showcase).toContain("marketing-product-image");
    expect(showcase).toContain("storeos-pos-hero-light.png");
    expect(showcase).toContain("storeos-pos-hero-dark.png");
    expect(showcase).not.toContain("MarketingThreeScene");
    expect(showcase).not.toContain("marketing-visual-stage");
    expect(showcase).toContain('className: "is-qr"');
    expect(showcase).toContain("LOGIN_GLASS_CARDS");
    expect(showcase).not.toContain("GLASS_CARDS.slice(0, 3)");
    expect(landingWorkflow).toContain('"use client"');
    expect(landingWorkflow).toContain("useState(0)");
    expect(landingWorkflow).toContain("--workflow-progress");
    expect(landingWorkflow).toContain("aria-live=\"polite\"");
    expect(landingWorkflow).toContain("data-step={activeIndex + 1}");
    expect(landingWorkflow).toContain("aria-pressed");
    expect(landingWorkflow).toContain("setActiveIndex");
    expect(landingWorkflow).toContain("reference-feature-picture");
    expect(landingWorkflow).toContain("activeStep.image.desktop");
    expect(landingWorkflow).toContain("activeStep.image.mobile");
    expect(landingWorkflow).not.toContain("MarketingProductShowcase");
    expect(nextConfig).toContain('allowedDevOrigins: ["127.0.0.1"]');
    for (const assetPath of [
      "public/marketing/workflow/pos-desktop.png",
      "public/marketing/workflow/pos-mobile.png",
      "public/marketing/workflow/qr-ordering-desktop.png",
      "public/marketing/workflow/qr-ordering-mobile.png",
      "public/marketing/workflow/stock-desktop.png",
      "public/marketing/workflow/stock-mobile.png",
      "public/marketing/workflow/attendance-desktop.png",
      "public/marketing/workflow/attendance-mobile.png",
      "public/marketing/workflow/reports-desktop.png",
      "public/marketing/workflow/reports-mobile.png",
      "public/marketing/workflow/branches-desktop.png",
      "public/marketing/workflow/branches-mobile.png",
    ]) {
      expect(existsSync(join(root, assetPath)), `${assetPath} must exist for workflow responsive artwork`).toBe(true);
      expect(landing).toContain(assetPath.replace("public", ""));
    }
    expect(css).toContain("@keyframes glassCardFloat");
    expect(css).toContain("@keyframes workflowPanelIn");
    expect(css).toContain("@keyframes workflowItemIn");
    expect(css).toContain(".reference-feature-picture");
    expect(css).toContain(".reference-feature-image");
    const workflowFeatureStyles = css.slice(css.indexOf(".reference-feature-picture"));
    const workflowMobileFeatureVisualBlock =
      workflowFeatureStyles
        .slice(workflowFeatureStyles.indexOf("@media (max-width: 767px)"))
        .match(/\.reference-feature-visual \{[^}]*\}/)?.[0] ?? "";
    expect(workflowMobileFeatureVisualBlock).toContain("order: -1;");
    expect(css).toContain("--card-transform");
    expect(css).toContain("--card-scale");
    expect(css).toContain("mask-image: radial-gradient");
    expect(css).toContain("-webkit-mask-image");
    expect(css).toContain("--workflow-progress");
    expect(css).toContain("transform: scale(0.94)");
    expect(css).toContain(".marketing-card-icon.is-time");
    expect(css).toContain(".reference-hero-visual .marketing-glass-card.is-time");
    expect(css).toContain(".reference-auth-showcase .marketing-glass-card.is-time");
    const heroTimeCardBlock = css.match(/\.reference-hero-visual \.marketing-glass-card\.is-time \{[^}]*\}/)?.[0] ?? "";
    const heroTimeCardResponsiveBlock =
      css.slice(css.indexOf("@media (max-width: 1180px)")).match(/\.reference-hero-visual \.marketing-glass-card\.is-time \{[^}]*\}/)?.[0] ?? "";
    expect(heroTimeCardBlock).toContain("left: auto;");
    expect(heroTimeCardResponsiveBlock).toContain("left: auto;");
    expect(showcase).toContain('title: "ลงเวลา"');
    expect(css).toContain(".reference-step-line button");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(landing).toContain("LandingWorkflow");
    // Login renders a responsive split-screen background (desktop/tablet/mobile assets), not the procedural showcase.
    expect(login).toContain("reference-auth-bg");
    expect(login).toContain("<picture>");
    expect(login).toContain("storeos-login-bg-desktop.png");
    expect(login).toContain("storeos-login-bg-tablet.png");
    expect(login).toContain("storeos-login-bg-mobile.png");
    expect(login).not.toContain("MarketingProductShowcase");
    expect(landing).toContain("marketing-page");
    expect(pricing).toContain("marketing-page");
    expect(pricing).toContain("PricingPlans");
    expect(pricing).toContain('id="enterprise-contact"');
    expect(pricing).toContain("support@storeos.app");
    expect(pricingPlans).toContain("useState<BillingPeriod>");
    expect(pricingPlans).toContain("price1y");
    expect(pricingPlans).toContain("#enterprise-contact");
    expect(pricingPlans).not.toContain("/register?plan=enterprise");
    expect(login).toContain("reference-auth-page");
  });

  it("marketing redesign covers tablet layout and mobile-first login", () => {
    const css = read("src/app/globals.css");

    expect(css).toContain("@media (max-width: 1100px)");
    expect(css).toContain(".reference-pricing-grid");
    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(css).toContain(".reference-billing-toggle button");
    expect(css).toContain(".reference-auth-page");
    expect(css).toContain(".reference-auth-visual");
    expect(css).toContain(".reference-auth-bg");
    expect(css).toContain(".reference-hero-visual .marketing-glass-card.is-pos");
    expect(css).toContain(".reference-auth-showcase .marketing-glass-card.is-report");
    expect(css).toContain("top: 1.05rem");
    expect(css).toContain("bottom: auto");
    expect(css).toContain("display: none");
    expect(css).toContain(".reference-auth-form-wrap");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)");
    expect(css).toContain("width: min(100%, 22rem)");
    expect(css).toContain("order: 1");
    expect(css).toContain("order: 2");
  });

  it("auth route-group pages are not shadowed by empty top-level app folders", () => {
    for (const segment of ["login", "register", "reset-password"]) {
      expect(existsSync(join(root, `src/app/(auth)/${segment}/page.tsx`))).toBe(true);

      const topLevelRoute = join(root, `src/app/${segment}`);
      if (!existsSync(topLevelRoute)) continue;

      const entries = readdirSync(topLevelRoute).filter((name) => !name.startsWith("."));
      expect(
        entries,
        `src/app/${segment} must not be empty because it can shadow src/app/(auth)/${segment}`
      ).not.toHaveLength(0);
    }
  });

  it("pricing keeps the one-time Premium free trial copy after visual redesign", () => {
    const pricing = read("src/app/pricing/page.tsx");
    const pricingPlans = read("src/app/pricing/PricingPlans.tsx");
    const shell = read("src/shared/components/marketing/MarketingShell.tsx");
    const pricingSurface = `${pricing}\n${pricingPlans}`;

    expect(pricingSurface).toContain("0 บาท");
    expect(pricingSurface).toContain("/ 30 วันแรก");
    expect(pricingSurface).toContain("หลังจากนั้น");
    expect(pricingSurface).toContain("โปร Premium ฟรี 30 วันใช้ได้ 1 ครั้งต่อบัญชี");
    expect(pricing).toContain("ลูกค้าใหม่รับ Premium ฟรี 30 วันได้ 1 ครั้งต่อบัญชี");
    expect(pricingSurface).toContain("ใช้ได้ 1 ครั้งต่อบัญชี");
    expect(pricing).not.toContain("reference-promo-strip");
    expect(pricing).not.toContain("7,415 บาท");
    expect(shell).toContain("PRICING_NAV_ITEMS");
    expect(shell).toContain('active === "pricing"');
    expect(pricingSurface).not.toContain("ทดลองใช้ฟรี 30 วัน ไม่ต้องใช้บัตรเครดิต");
  });

  it("staff HR policy save gives visible feedback and explains monthly absent penalty", () => {
    const staff = read("src/app/(dashboard)/staff/StaffManager.tsx");

    expect(staff).toContain("บันทึกนโยบายเรียบร้อยแล้ว");
    expect(staff).toContain('aria-live="polite"');
    expect(staff).toContain("กำลังบันทึก...");
    expect(staff).toContain("รายเดือนใช้เงินเดือน ÷ จำนวนวัน");
  });
});
