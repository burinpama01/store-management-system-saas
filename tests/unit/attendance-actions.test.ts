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
  getActiveRecordToday: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  notifyOwnerSafely: vi.fn(),
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
  getActiveRecordToday: mocks.getActiveRecordToday,
  clockIn: mocks.clockIn,
  clockOut: mocks.clockOut,
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

vi.mock("@/modules/notifications/dispatcher", () => ({
  notifyOwnerSafely: mocks.notifyOwnerSafely,
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
    mocks.getActiveRecordToday.mockResolvedValue(null);
    mocks.clockIn.mockResolvedValue({ data: null, error: null });
    mocks.clockOut.mockResolvedValue({ data: null, error: null });
  });

  it("notifies owners after a successful employee clock-in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T02:15:00.000Z"));
    mocks.clockIn.mockResolvedValue({
      data: {
        id: "att-1",
        userId: MANAGER_ID,
        organizationId: "org-1",
        storeId: "store-1",
        employeeName: "manager@example.com",
        date: "2026-06-20",
        clockInAt: "2026-06-20T02:15:00.000Z",
        clockOutAt: null,
        status: "active",
        createdAt: "2026-06-20T02:15:00.000Z",
        updatedAt: "2026-06-20T02:15:00.000Z",
      },
      error: null,
    });
    const { clockInAction } = await import("@/app/(dashboard)/attendance/actions");

    try {
      const result = await clockInAction(fd({ lat: "13.75", lng: "100.5", locationLabel: "หน้าร้าน" }));

      expect(result.error).toBeNull();
      expect(mocks.notifyOwnerSafely).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "attendance_clock_in",
          organizationId: "org-1",
          storeId: "store-1",
          title: "พนักงานเข้างาน",
          message: expect.stringContaining("manager@example.com"),
          metadata: expect.objectContaining({
            attendanceRecordId: "att-1",
            userId: MANAGER_ID,
            action: "clock_in",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies owners after a successful employee clock-out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T11:05:00.000Z"));
    mocks.getActiveRecordToday.mockResolvedValue({
      id: "att-1",
      userId: MANAGER_ID,
      organizationId: "org-1",
      storeId: "store-1",
      employeeName: "manager@example.com",
      date: "2026-06-20",
      clockInAt: "2026-06-20T02:15:00.000Z",
      clockOutAt: null,
      status: "active",
      createdAt: "2026-06-20T02:15:00.000Z",
      updatedAt: "2026-06-20T02:15:00.000Z",
    });
    mocks.clockOut.mockResolvedValue({
      data: {
        id: "att-1",
        userId: MANAGER_ID,
        organizationId: "org-1",
        storeId: "store-1",
        employeeName: "manager@example.com",
        date: "2026-06-20",
        clockInAt: "2026-06-20T02:15:00.000Z",
        clockOutAt: "2026-06-20T11:05:00.000Z",
        status: "completed",
        createdAt: "2026-06-20T02:15:00.000Z",
        updatedAt: "2026-06-20T11:05:00.000Z",
      },
      error: null,
    });
    const { clockOutAction } = await import("@/app/(dashboard)/attendance/actions");

    try {
      const result = await clockOutAction(fd({ lat: "13.75", lng: "100.5", locationLabel: "หน้าร้าน" }));

      expect(result.error).toBeNull();
      expect(mocks.notifyOwnerSafely).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "attendance_clock_out",
          organizationId: "org-1",
          storeId: "store-1",
          title: "พนักงานออกงาน",
          message: expect.stringContaining("manager@example.com"),
          metadata: expect.objectContaining({
            attendanceRecordId: "att-1",
            userId: MANAGER_ID,
            action: "clock_out",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
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
