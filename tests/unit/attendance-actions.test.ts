import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const MANAGER_ID = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentUser: vi.fn(),
  getUserStores: vi.fn(),
  resolveCurrentStore: vi.fn(),
  listStoreMemberships: vi.fn(),
  addPayrollAdjustment: vi.fn(),
  addManualAttendance: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/modules/auth/guards", () => ({
  requirePermission: mocks.requirePermission,
}));

vi.mock("@/modules/auth/session", () => ({
  getCurrentUser: mocks.getCurrentUser,
  getUserStores: mocks.getUserStores,
  resolveCurrentStore: mocks.resolveCurrentStore,
}));

vi.mock("@/modules/settings/repository", () => ({
  listStoreMemberships: mocks.listStoreMemberships,
}));

vi.mock("@/modules/hr/repository", () => ({
  addPayrollAdjustment: mocks.addPayrollAdjustment,
  deletePayrollAdjustment: vi.fn(),
  getStoreHrSettings: vi.fn(async () => ({ backdatedRightsPerMonth: 3 })),
}));

vi.mock("@/modules/attendance/repository", () => ({
  getTodayRecord: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  getAttendanceSettings: vi.fn(async () => ({ data: null, error: null })),
  upsertAttendanceSettings: vi.fn(),
  addManualAttendance: mocks.addManualAttendance,
  adjustAttendanceRecord: vi.fn(),
  deleteAttendanceRecord: vi.fn(),
  countSelfBackdated: vi.fn(async () => 0),
  nextMonthStart: vi.fn((date: string) => `${date.slice(0, 7)}-32`),
  addStoreHoliday: vi.fn(),
  deleteStoreHoliday: vi.fn(),
}));

vi.mock("@/modules/billing/billing-service", () => ({
  getOrganizationBillingState: vi.fn(async () => null),
}));

function fd(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

describe("attendance manager actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue(undefined);
    mocks.getCurrentUser.mockResolvedValue({ id: MANAGER_ID, email: "manager@example.com" });
    mocks.getUserStores.mockResolvedValue({ organizations: [], stores: [], memberships: [] });
    mocks.resolveCurrentStore.mockResolvedValue({
      organizationId: "org-1",
      storeId: "store-1",
      storeTimezone: "Asia/Bangkok",
    });
    mocks.listStoreMemberships.mockResolvedValue({
      data: [
        {
          userId: USER_ID,
          email: "staff@example.com",
          role: "staff",
        },
      ],
      error: null,
    });
    mocks.addPayrollAdjustment.mockResolvedValue({ ok: true, error: null });
    mocks.addManualAttendance.mockResolvedValue({ ok: true, error: null });
  });

  it("rejects employee leave for a user outside the current store before inserting payroll adjustment", async () => {
    const { addEmployeeLeaveAction } = await import("@/app/(dashboard)/attendance/actions");

    const result = await addEmployeeLeaveAction(fd({
      userId: OTHER_USER_ID,
      employeeName: "Injected Name",
      date: "2026-06-17",
    }));

    expect(result.error).toBe("ไม่พบพนักงานในร้านนี้");
    expect(mocks.addPayrollAdjustment).not.toHaveBeenCalled();
  });

  it("uses the server-side member email for employee leave instead of hidden employeeName", async () => {
    const { addEmployeeLeaveAction } = await import("@/app/(dashboard)/attendance/actions");

    const result = await addEmployeeLeaveAction(fd({
      userId: USER_ID,
      employeeName: "Injected Name",
      date: "2026-06-17",
      note: "ลาพักร้อน",
    }));

    expect(result.error).toBeNull();
    expect(mocks.addPayrollAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        employeeName: "staff@example.com",
        date: "2026-06-17",
        type: "leave",
        amount: 0,
      }),
    );
  });

  it("uses the server-side member email for manual attendance instead of hidden employeeName", async () => {
    const { addManualAttendanceAction } = await import("@/app/(dashboard)/attendance/actions");

    const result = await addManualAttendanceAction(fd({
      userId: USER_ID,
      employeeName: "Injected Name",
      date: "2026-06-17",
      clockInAt: "2026-06-17T09:00",
      clockOutAt: "2026-06-17T18:00",
    }));

    expect(result.error).toBeNull();
    expect(mocks.addManualAttendance).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        employeeName: "staff@example.com",
      }),
    );
  });
});
