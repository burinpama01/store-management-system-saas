import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("attendance UX + RBAC visibility batch", () => {
  it("3) adds store-level working days (migration + types + repo + calendar fallback + UI)", () => {
    const migration = "supabase/migrations/20260626130000_store_working_days.sql";
    expect(existsSync(join(root, migration))).toBe(true);
    expect(read(migration)).toContain("add column if not exists working_days int[] not null default '{0,1,2,3,4,5,6}'");

    const hrTypes = read("src/modules/hr/types.ts");
    expect(hrTypes).toContain("workingDays: number[]");
    expect(hrTypes).toContain("workingDays: [0, 1, 2, 3, 4, 5, 6]");

    const hrRepo = read("src/modules/hr/repository.ts");
    expect(hrRepo).toContain("workingDays: row.working_days");
    expect(hrRepo).toContain("export async function updateStoreWorkingDays");

    const page = read("src/app/(dashboard)/attendance/page.tsx");
    expect(page).toContain("storeWorkingDays");
    expect(page).toContain("effectiveWorkingDays");
    expect(page).toContain("ownProfile?.workingDays?.length ? ownProfile.workingDays : storeWorkingDays");

    const manager = read("src/app/(dashboard)/attendance/AttendanceManager.tsx");
    expect(manager).toContain("saveStoreWorkingDaysAction");
    expect(manager).toContain("วันเปิดทำการของร้าน");
    expect(manager).toContain('name="workingDays"');
  });

  it("2) requires a real captured location whenever the store's GPS is enabled", () => {
    const policy = read("src/modules/attendance/policy.ts");
    // location is now required before the optional radius check
    const idxLocation = policy.indexOf("กรุณาอนุญาตตำแหน่งเพื่อบันทึกเวลา");
    const idxRadius = policy.indexOf("!policy.center || policy.radiusMeters === undefined");
    expect(idxLocation).toBeGreaterThan(-1);
    expect(idxRadius).toBeGreaterThan(-1);
    expect(idxLocation).toBeLessThan(idxRadius);

    const actions = read("src/app/(dashboard)/attendance/actions.ts");
    expect(actions).toContain("if (!settings?.geofenceEnabled) return { gpsEnabled: false };");
  });

  it("6) blocks clock-out for cashier/staff while a cash session is open", () => {
    const actions = read("src/app/(dashboard)/attendance/actions.ts");
    expect(actions).toContain("getOpenCashSession");
    expect(actions).toContain('ctx.role === "cashier" || ctx.role === "staff"');
    expect(actions).toContain("กรุณาปิดรอบเงินสดก่อนออกงาน");
  });

  it("7) hides profit/loss totals from below-manager on the accounting page", () => {
    const page = read("src/app/(dashboard)/accounting/page.tsx");
    expect(page).toContain('canViewTotals={resolved.can("reports.view")}');

    const manager = read("src/app/(dashboard)/accounting/AccountingManager.tsx");
    expect(manager).toContain("canViewTotals: boolean");
    expect(manager).toContain("{canViewTotals && (");
    // cash recording stays available for everyone with cashflow.record
    expect(manager).toContain("เงินสดปัจจุบัน");
  });

  it("8) hides customer management from below-manager (POS customer use unaffected)", () => {
    const layout = read("src/app/(dashboard)/layout.tsx");
    expect(layout).toContain('...(can("catalog.manage") ? [{ href: "/customers", label: "ลูกค้า" }] : [])');

    const customersPage = read("src/app/(dashboard)/customers/page.tsx");
    expect(customersPage).toContain('if (!resolved.can("catalog.manage")) redirect("/dashboard")');
  });

  it("1+4+5) collapsible form sections that clearly separate store holiday vs employee leave", () => {
    const manager = read("src/app/(dashboard)/attendance/AttendanceManager.tsx");
    expect(manager).toContain("function Collapsible");
    expect(manager).toContain("วันหยุดร้าน (ปิดทั้งร้าน)");
    expect(manager).toContain("วันลาพนักงาน (รายบุคคล)");
    // retroactive edit (owner/manager) still wired
    expect(manager).toContain("adjustAttendanceAction");
    expect(manager).toContain("addManualAttendanceAction");
  });
});
