import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const MANAGER_ID = "33333333-3333-4333-8333-333333333333";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getCurrentUser: vi.fn(),
  getUserStores: vi.fn(),
  resolveCurrentStore: vi.fn(),
  getStore: vi.fn(),
  listStoreMemberships: vi.fn(),
  addPayrollAdjustment: vi.fn(),
  addManualAttendance: vi.fn(),
  getActiveRecordToday: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  notifyOwnerSafely: vi.fn(),
  notifyOwnerNow: vi.fn(),
  loadStoreDailySummary: vi.fn(),
  countOpenShiftsInStore: vi.fn(),
  claimDailySummaryNotification: vi.fn(),
  completeDailySummaryNotification: vi.fn(),
  logSystemEvent: vi.fn(),
  logActionError: vi.fn(),
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

vi.mock("@/modules/stores/repository", () => ({
  getStore: mocks.getStore,
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
  notifyOwnerNow: mocks.notifyOwnerNow,
}));

vi.mock("@/modules/reports/daily-summary-repository", () => ({
  loadStoreDailySummary: mocks.loadStoreDailySummary,
}));

vi.mock("@/modules/attendance/shift-status-repository", () => ({
  countOpenShiftsInStore: mocks.countOpenShiftsInStore,
  claimDailySummaryNotification: mocks.claimDailySummaryNotification,
  completeDailySummaryNotification: mocks.completeDailySummaryNotification,
}));

vi.mock("@/modules/system/event-log", () => ({
  logSystemEvent: mocks.logSystemEvent,
  logActionError: mocks.logActionError,
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
    mocks.getStore.mockResolvedValue({ data: { timezone: "Asia/Bangkok" }, error: null });
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
    mocks.notifyOwnerNow.mockResolvedValue(true);
    mocks.loadStoreDailySummary.mockResolvedValue(null);
    mocks.countOpenShiftsInStore.mockResolvedValue(0);
    mocks.claimDailySummaryNotification.mockResolvedValue(true);
    mocks.completeDailySummaryNotification.mockResolvedValue(undefined);
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

  // งานใหม่ 2026-09-09: คนสุดท้ายที่ออกงาน = เจ้าของได้สรุปยอดของวันนั้นทาง LINE/Telegram/Push
  it("ส่งสรุปยอดของวันนั้นถึงเจ้าของเมื่อคนสุดท้ายกดออกงานและวันนั้นมีการขาย", async () => {
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
    // current context อาจอยู่คนละสาขา แต่สรุปต้องใช้ timezone ของ recordStoreId
    mocks.resolveCurrentStore.mockResolvedValue({
      organizationId: "org-1",
      storeId: "store-other",
      storeTimezone: "America/Los_Angeles",
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
    mocks.loadStoreDailySummary.mockResolvedValue({
      storeId: "store-1",
      storeName: "",
      orderCount: 12,
      revenue: 3450,
      avgOrderValue: 287.5,
      posOrderCount: 10,
      qrOrderCount: 2,
      deliveryOrderCount: 0,
      voidedCount: 0,
      paymentMethods: [{ method: "cash", count: 10, amount: 2450 }],
      topProducts: [{ name: "กาแฟเย็น", quantity: 9, revenue: 540 }],
    });
    const { clockOutAction } = await import("@/app/(dashboard)/attendance/actions");

    try {
      const result = await clockOutAction(fd({}));
      expect(result.error).toBeNull();
      // after() ไม่มี request context ในเทสต์ จึงตกไปทาง fallback ที่รันทันที — รอ microtask ให้จบก่อน
      await vi.waitFor(() => expect(mocks.notifyOwnerNow).toHaveBeenCalled());

      expect(mocks.loadStoreDailySummary).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: "store-1", organizationId: "org-1", date: "2026-06-20", timezone: "Asia/Bangkok" }),
      );
      expect(mocks.claimDailySummaryNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store-1",
          organizationId: "org-1",
          date: "2026-06-20",
          attendanceRecordId: "att-1",
        }),
      );
      expect(mocks.notifyOwnerNow).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "daily_summary",
          organizationId: "org-1",
          storeId: "store-1",
          message: expect.stringContaining("3,450.00"),
          metadata: expect.objectContaining({ orderCount: 12, revenue: 3450 }),
        }),
      );
      expect(mocks.completeDailySummaryNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store-1",
          organizationId: "org-1",
          date: "2026-06-20",
          delivered: true,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // ผู้ใช้สั่ง 2026-09-09: ส่งเฉพาะคนสุดท้าย ไม่งั้นเจ้าของโดนข้อความซ้ำทุกคนที่ออกงาน
  it("ไม่ส่งสรุปยอดเมื่อยังมีเพื่อนร่วมงานค้างกะอยู่", async () => {
    mocks.getActiveRecordToday.mockResolvedValue({
      id: "att-3",
      userId: MANAGER_ID,
      organizationId: "org-1",
      storeId: "store-1",
      employeeName: "manager@example.com",
      date: "2026-06-22",
      clockInAt: "2026-06-22T02:15:00.000Z",
      clockOutAt: null,
      status: "active",
      createdAt: "2026-06-22T02:15:00.000Z",
      updatedAt: "2026-06-22T02:15:00.000Z",
    });
    mocks.clockOut.mockResolvedValue({
      data: {
        id: "att-3",
        userId: MANAGER_ID,
        organizationId: "org-1",
        storeId: "store-1",
        employeeName: "manager@example.com",
        date: "2026-06-22",
        clockInAt: "2026-06-22T02:15:00.000Z",
        clockOutAt: "2026-06-22T08:00:00.000Z",
        status: "completed",
        createdAt: "2026-06-22T02:15:00.000Z",
        updatedAt: "2026-06-22T08:00:00.000Z",
      },
      error: null,
    });
    mocks.countOpenShiftsInStore.mockResolvedValue(2);
    const { clockOutAction } = await import("@/app/(dashboard)/attendance/actions");

    const result = await clockOutAction(fd({}));

    expect(result.error).toBeNull();
    await vi.waitFor(() => expect(mocks.countOpenShiftsInStore).toHaveBeenCalled());
    expect(mocks.countOpenShiftsInStore).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "store-1", date: "2026-06-22", excludeRecordId: "att-3" }),
    );
    // ไม่แตะฐานข้อมูลรายงานเลยเมื่อยังไม่ใช่คนสุดท้าย
    expect(mocks.loadStoreDailySummary).not.toHaveBeenCalled();
    expect(mocks.notifyOwnerNow).not.toHaveBeenCalled();
  });

  it("ไม่ส่งสรุปยอดเมื่อเช็คคนค้างกะไม่ได้", async () => {
    mocks.getActiveRecordToday.mockResolvedValue({
      id: "att-4",
      userId: MANAGER_ID,
      organizationId: "org-1",
      storeId: "store-1",
      employeeName: "manager@example.com",
      date: "2026-06-23",
      clockInAt: "2026-06-23T02:15:00.000Z",
      clockOutAt: null,
      status: "active",
      createdAt: "2026-06-23T02:15:00.000Z",
      updatedAt: "2026-06-23T02:15:00.000Z",
    });
    mocks.clockOut.mockResolvedValue({
      data: {
        id: "att-4",
        userId: MANAGER_ID,
        organizationId: "org-1",
        storeId: "store-1",
        employeeName: "manager@example.com",
        date: "2026-06-23",
        clockInAt: "2026-06-23T02:15:00.000Z",
        clockOutAt: "2026-06-23T08:00:00.000Z",
        status: "completed",
        createdAt: "2026-06-23T02:15:00.000Z",
        updatedAt: "2026-06-23T08:00:00.000Z",
      },
      error: null,
    });
    mocks.countOpenShiftsInStore.mockResolvedValue(null);
    const { clockOutAction } = await import("@/app/(dashboard)/attendance/actions");

    const result = await clockOutAction(fd({}));

    expect(result.error).toBeNull();
    await vi.waitFor(() => expect(mocks.logSystemEvent).toHaveBeenCalled());
    expect(mocks.loadStoreDailySummary).not.toHaveBeenCalled();
    expect(mocks.claimDailySummaryNotification).not.toHaveBeenCalled();
    expect(mocks.notifyOwnerNow).not.toHaveBeenCalled();
  });

  it("ไม่ส่งสรุปซ้ำเมื่ออีกคำขอจองสิทธิ์ของร้านและวันเดียวกันไปแล้ว", async () => {
    mocks.getActiveRecordToday.mockResolvedValue({
      id: "att-5",
      userId: MANAGER_ID,
      organizationId: "org-1",
      storeId: "store-1",
      employeeName: "manager@example.com",
      date: "2026-06-24",
      clockInAt: "2026-06-24T02:15:00.000Z",
      clockOutAt: null,
      status: "active",
      createdAt: "2026-06-24T02:15:00.000Z",
      updatedAt: "2026-06-24T02:15:00.000Z",
    });
    mocks.clockOut.mockResolvedValue({
      data: {
        id: "att-5",
        userId: MANAGER_ID,
        organizationId: "org-1",
        storeId: "store-1",
        employeeName: "manager@example.com",
        date: "2026-06-24",
        clockInAt: "2026-06-24T02:15:00.000Z",
        clockOutAt: "2026-06-24T08:00:00.000Z",
        status: "completed",
        createdAt: "2026-06-24T02:15:00.000Z",
        updatedAt: "2026-06-24T08:00:00.000Z",
      },
      error: null,
    });
    mocks.loadStoreDailySummary.mockResolvedValue({
      storeId: "store-1",
      storeName: "",
      orderCount: 2,
      revenue: 500,
      avgOrderValue: 250,
      posOrderCount: 2,
      qrOrderCount: 0,
      deliveryOrderCount: 0,
      voidedCount: 0,
      paymentMethods: [],
      topProducts: [],
    });
    mocks.claimDailySummaryNotification.mockResolvedValue(false);
    const { clockOutAction } = await import("@/app/(dashboard)/attendance/actions");

    const result = await clockOutAction(fd({}));

    expect(result.error).toBeNull();
    await vi.waitFor(() => expect(mocks.claimDailySummaryNotification).toHaveBeenCalled());
    expect(mocks.notifyOwnerNow).not.toHaveBeenCalled();
    expect(mocks.completeDailySummaryNotification).not.toHaveBeenCalled();
  });

  it("ไม่ส่งสรุปยอดเมื่อวันนั้นยังไม่มีออเดอร์เลย", async () => {
    mocks.getActiveRecordToday.mockResolvedValue({
      id: "att-2",
      userId: MANAGER_ID,
      organizationId: "org-1",
      storeId: "store-1",
      employeeName: "manager@example.com",
      date: "2026-06-21",
      clockInAt: "2026-06-21T02:15:00.000Z",
      clockOutAt: null,
      status: "active",
      createdAt: "2026-06-21T02:15:00.000Z",
      updatedAt: "2026-06-21T02:15:00.000Z",
    });
    mocks.clockOut.mockResolvedValue({
      data: {
        id: "att-2",
        userId: MANAGER_ID,
        organizationId: "org-1",
        storeId: "store-1",
        employeeName: "manager@example.com",
        date: "2026-06-21",
        clockInAt: "2026-06-21T02:15:00.000Z",
        clockOutAt: "2026-06-21T11:05:00.000Z",
        status: "completed",
        createdAt: "2026-06-21T02:15:00.000Z",
        updatedAt: "2026-06-21T11:05:00.000Z",
      },
      error: null,
    });
    mocks.loadStoreDailySummary.mockResolvedValue(null);
    mocks.countOpenShiftsInStore.mockResolvedValue(0);
    const { clockOutAction } = await import("@/app/(dashboard)/attendance/actions");

    const result = await clockOutAction(fd({}));

    expect(result.error).toBeNull();
    await vi.waitFor(() => expect(mocks.loadStoreDailySummary).toHaveBeenCalled());
    expect(mocks.notifyOwnerNow).not.toHaveBeenCalled();
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
