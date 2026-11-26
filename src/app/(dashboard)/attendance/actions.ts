"use server";

import { revalidatePath } from "next/cache";
import { getOrganizationBillingState } from "@/modules/billing/billing-service";
import {
  DEFAULT_BILLING_STATE,
  getPlanFeatures,
} from "@/modules/billing/types";
import { requirePermission } from "@/modules/auth/guards";
import { getCurrentUser, getUserStores, resolveCurrentStore } from "@/modules/auth/session";
import {
  abandonStaleActiveRecords,
  getActiveRecordToday,
  clockIn,
  clockOut,
  getAttendanceSettings,
  upsertAttendanceSettings,
  addManualAttendance,
  adjustAttendanceRecord,
  findOpenRecordForDay,
  deleteAttendanceRecord,
  addStoreHoliday,
  deleteStoreHoliday,
} from "@/modules/attendance/repository";
import {
  addPayrollAdjustment,
  deletePayrollAdjustment,
  updateStoreWorkingDays,
} from "@/modules/hr/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import { getOpenCashSession } from "@/modules/cashflow/repository";
import { getStoreLocalDate, storeDateTimeToUtc } from "@/modules/attendance/date";
import { parseClockLocation, validateAttendanceGpsPolicy } from "@/modules/attendance/policy";
import { after } from "next/server";
import { notifyOwnerNow, notifyOwnerSafely } from "@/modules/notifications/dispatcher";
import { loadStoreDailySummary } from "@/modules/reports/daily-summary-repository";
import {
  claimDailySummaryNotification,
  completeDailySummaryNotification,
  countOpenShiftsInStore,
} from "@/modules/attendance/shift-status-repository";
import { buildDailySummaryMessage } from "@/modules/reports/daily-summary";
import { logActionError, logSystemEvent } from "@/modules/system/event-log";
import { decideBackdateRequest, submitBackdateRequest } from "@/modules/attendance/backdate-requests";
import type { AttendanceGpsPolicy } from "@/modules/attendance/policy";
import { getStore } from "@/modules/stores/repository";
import { checkClockOutChecklistGate } from "@/modules/operations/clock-out-gate";

async function getStoreContext() {
  const user = await getCurrentUser();
  if (!user) throw new Error("ไม่มีสิทธิ์เข้าถึง");
  const { organizations, stores, memberships } = await getUserStores();
  const ctx = await resolveCurrentStore(stores, organizations, memberships);
  if (!ctx) throw new Error("ไม่พบข้อมูลร้านค้า");
  return { user, ctx };
}

async function getAttendanceGpsPolicy(
  storeId: string,
  organizationId: string,
): Promise<AttendanceGpsPolicy> {
  const billingState =
    (await getOrganizationBillingState(organizationId)) ??
    DEFAULT_BILLING_STATE;
  const features = getPlanFeatures(billingState);
  if (!features.attendanceGps) return { gpsEnabled: false };

  const settingsResult = await getAttendanceSettings(storeId, organizationId);
  if (settingsResult.error) throw new Error(settingsResult.error.userMessage);

  const settings = settingsResult.data;
  // GPS is required only for stores that turned the geofence ON. When ON, a real captured
  // location is mandatory; if a center/radius is also set, the location must be within it.
  if (!settings?.geofenceEnabled) return { gpsEnabled: false };

  if (
    settings.geofenceCenterLat === undefined ||
    settings.geofenceCenterLng === undefined ||
    settings.geofenceRadiusMeters === undefined
  ) {
    return { gpsEnabled: true };
  }

  return {
    gpsEnabled: true,
    center: {
      lat: settings.geofenceCenterLat,
      lng: settings.geofenceCenterLng,
    },
    radiusMeters: settings.geofenceRadiusMeters,
  };
}

function formatClockNotificationTime(value: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("th-TH", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

/**
 * สรุปยอดของวันนั้นส่งถึงเจ้าของตอนพนักงานกดออกงาน (LINE/Telegram/Push + ศูนย์แจ้งเตือน)
 *
 * ส่ง **เฉพาะคนสุดท้ายที่ออกงาน** ของสาขานั้นในวันนั้น (ผู้ใช้สั่งไว้ 2026-09-09)
 * — ยังมีคนค้างกะอยู่แปลว่าร้านยังไม่ปิด ตัวเลขยังไม่นิ่ง และเจ้าของจะโดนข้อความซ้ำหลายฉบับ
 *
 * ทำหลังตอบ request (after) เพราะต้องยิงหลาย query — พนักงานต้องไม่รอ
 * ไม่มีออเดอร์ที่ปิดบิลวันนั้น = ไม่ส่ง (ไม่มีอะไรให้เจ้าของอ่าน)
 * เจ้าของปิดได้เองที่ ตั้งค่า > การแจ้งเตือน > "สรุปยอดประจำวัน" ต่อช่องทาง
 */
function notifyDailySummaryAfterClockOut(input: {
  organizationId: string;
  storeId: string;
  timezone: string;
  employeeName: string;
  date: string;
  attendanceRecordId: string;
}): void {
  const run = async () => {
    try {
      const openShifts = await countOpenShiftsInStore({
        storeId: input.storeId,
        organizationId: input.organizationId,
        date: input.date,
        excludeRecordId: input.attendanceRecordId,
      });
      // อ่านไม่ได้ = ยืนยันไม่ได้ว่าเป็นคนสุดท้าย ต้อง fail closed เพื่อไม่ส่งยอดระหว่างร้านยังเปิด
      if (openShifts === null) {
        await logSystemEvent({
          level: "warn",
          source: "attendance.daily-summary",
          action: "countOpenShiftsInStore",
          message: "เช็คคนค้างกะไม่ได้ — ข้ามสรุปยอดเพื่อไม่ส่งก่อนร้านปิด",
          organizationId: input.organizationId,
          storeId: input.storeId,
          context: { date: input.date },
        });
        return;
      }
      // ยังมีคนไม่กดออก = ยังไม่ใช่คนสุดท้าย ไม่ต้องส่ง
      if (openShifts > 0) return;

      const summary = await loadStoreDailySummary({
        storeId: input.storeId,
        organizationId: input.organizationId,
        storeName: "",
        date: input.date,
        timezone: input.timezone,
      });
      if (!summary) return;

      const claimed = await claimDailySummaryNotification({
        storeId: input.storeId,
        organizationId: input.organizationId,
        date: input.date,
        attendanceRecordId: input.attendanceRecordId,
      });
      if (!claimed) return;

      const trigger = `${input.employeeName} ออกงานแล้ว (คนสุดท้ายของวัน)`;
      const delivered = await notifyOwnerNow({
        type: "daily_summary",
        destination: "owner",
        title: "สรุปยอดประจำวัน",
        message: buildDailySummaryMessage(summary, input.date, { trigger }),
        organizationId: input.organizationId,
        storeId: input.storeId,
        metadata: {
          date: input.date,
          orderCount: summary.orderCount,
          revenue: summary.revenue,
          employeeName: input.employeeName,
          trigger,
        },
      });
      await completeDailySummaryNotification({
        storeId: input.storeId,
        organizationId: input.organizationId,
        date: input.date,
        delivered,
      });
      if (!delivered) {
        await logSystemEvent({
          level: "warn",
          source: "attendance.daily-summary",
          action: "notifyOwnerNow",
          message: "ส่งสรุปยอดไม่ครบทุกช่องทาง — เก็บ claim ไว้เพื่อป้องกันข้อความซ้ำ",
          organizationId: input.organizationId,
          storeId: input.storeId,
          context: { date: input.date, attendanceRecordId: input.attendanceRecordId },
        });
      }
    } catch (error) {
      logActionError({
        source: "attendance.daily-summary",
        action: "notifyDailySummaryAfterClockOut",
        error,
        organizationId: input.organizationId,
        storeId: input.storeId,
      });
    }
  };

  try {
    after(run);
  } catch {
    void run();
  }
}

export async function clockInAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.clock");
    const { user, ctx } = await getStoreContext();

    const now = new Date();
    const today = getStoreLocalDate(ctx.storeTimezone, now);

    // ลืมกดออกงานของวันก่อน ๆ = ปิดให้เป็นขาดงานตรงนี้ จังหวะเดียวที่รู้แน่ว่ากะเก่า
    // จบไปแล้ว (ระบบไม่มี auto clock-out) ถ้าพลาดจริงยังขอย้อนหลังให้ผู้จัดการแก้ได้
    const abandoned = await abandonStaleActiveRecords(user.id, ctx.organizationId, today);
    if (abandoned.count > 0) {
      void logSystemEvent({
        level: "warn",
        source: "attendance.clock",
        action: "abandonStaleRecords",
        message: "ปิดรายการลงเวลาที่ลืมกดออกงานเป็นขาดงาน",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        context: { userId: user.id, abandoned: abandoned.count, today },
      });
    } else if (abandoned.error) {
      // ปิดแถวเก่าไม่สำเร็จไม่ควรกันคนเข้างาน (เช่น migration ยังไม่ขึ้น constraint
      // จะปฏิเสธค่า abandoned) แต่ต้องไม่เงียบ ไม่งั้นแถวค้างจะสะสมโดยไม่มีใครรู้
      void logSystemEvent({
        level: "error",
        source: "attendance.clock",
        action: "abandonStaleRecordsFailed",
        message: "ปิดรายการลงเวลาที่ค้างไม่สำเร็จ — ปล่อยให้เข้างานต่อได้",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        context: { userId: user.id, today, error: abandoned.error.userMessage },
      });
    }

    // Org-wide: already having an open record at ANY branch blocks a second clock-in
    // (a completed earlier shift does not — allows a genuine second shift).
    const existing = await getActiveRecordToday(user.id, ctx.organizationId, today);
    if (existing) return { error: "คุณได้ลงชื่อเข้างานแล้ว" };

    const gpsPolicy = await getAttendanceGpsPolicy(ctx.storeId, ctx.organizationId);
    const locationAllowed = gpsPolicy.gpsEnabled;
    const latRaw = formData.get("lat") as string | null;
    const lngRaw = formData.get("lng") as string | null;
    const accuracyRaw = formData.get("accuracy") as string | null;
    const locationLabel = locationAllowed
      ? (formData.get("locationLabel") as string | null)?.trim() || undefined
      : undefined;
    const note = (formData.get("note") as string | null)?.trim() || undefined;

    const location = parseClockLocation(
      { lat: latRaw, lng: lngRaw, accuracy: accuracyRaw, locationLabel },
      locationAllowed,
    );
    const gpsPolicyError = validateAttendanceGpsPolicy(location, gpsPolicy);
    if (gpsPolicyError) return { error: gpsPolicyError };

    const result = await clockIn({
      userId: user.id,
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      employeeName: (user.email ?? user.id).slice(0, 100),
      date: today,
      clockInAt: now.toISOString(),
      lat: location.lat,
      lng: location.lng,
      locationLabel: location.locationLabel,
      note,
    });

    if (result.error) return { error: result.error.userMessage };
    if (result.data) {
      notifyOwnerSafely({
        type: "attendance_clock_in",
        organizationId: ctx.organizationId,
        storeId: ctx.storeId,
        title: "พนักงานเข้างาน",
        message: `${result.data.employeeName} เข้างาน เวลา ${formatClockNotificationTime(result.data.clockInAt, ctx.storeTimezone)}`,
        metadata: {
          attendanceRecordId: result.data.id,
          userId: result.data.userId,
          action: "clock_in",
          date: result.data.date,
          clockInAt: result.data.clockInAt,
          locationLabel: result.data.clockInLocationLabel ?? null,
        },
      });
    }

    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** กะที่เข้างานภายในกี่ชั่วโมงถึงนับว่า "ยังอยู่ในร้าน" ตอนตัดสินว่าต้องปิดรอบเงินสดก่อนออกไหม */
const CLOCK_OUT_RECENT_SHIFT_HOURS = 16;

export async function clockOutAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.clock");
    const { user, ctx } = await getStoreContext();

    const now = new Date();
    const today = getStoreLocalDate(ctx.storeTimezone, now);
    // Org-wide: find the open record wherever it was created, so clocking out works even
    // if the app now resolves a different default branch than the one clocked in at.
    const active = await getActiveRecordToday(user.id, ctx.organizationId, today);
    if (!active) return { error: "ไม่พบรายการที่รอลงชื่อออก" };
    // Operate on the branch the shift belongs to (not the currently-resolved store).
    const recordStoreId = active.storeId;

    // Cashier/staff must close that branch's open cash session before clocking out —
    // เฉพาะคนสุดท้ายที่ยังอยู่ในสาขา: ยังมีคนอื่นลงเวลาอยู่ (เช่นคนทำ OT) = ออกได้ คนที่อยู่ต่อเป็นคนปิดรอบ
    // นับเฉพาะกะที่เข้างานภายใน 16 ชม. — กะค้างวันเดียวกันที่ลืมกดออกต้องไม่ทำให้คนสุดท้ายจริงหลุดการปิดรอบ
    const recentShiftSince = new Date(now.getTime() - CLOCK_OUT_RECENT_SHIFT_HOURS * 60 * 60 * 1000).toISOString();
    let leftWithOpenCashSessionId: string | null = null;
    if (ctx.role === "cashier" || ctx.role === "staff") {
      const openSession = await getOpenCashSession(recordStoreId);
      if (openSession.error) return { error: openSession.error.userMessage };
      if (openSession.data) {
        const othersOnShift = await countOpenShiftsInStore({
          storeId: recordStoreId,
          organizationId: ctx.organizationId,
          date: active.date,
          excludeRecordId: active.id,
          clockedInSince: recentShiftSince,
        });
        // นับไม่ได้ (null) = ยืนยันไม่ได้ว่ามีคนอยู่ต่อ → บล็อกแบบเดิม (fail closed)
        if (!othersOnShift) return { error: "กรุณาปิดรอบเงินสดก่อนออกงาน" };
        leftWithOpenCashSessionId = openSession.data.id;
        await logSystemEvent({
          level: "info",
          source: "attendance.clock-out",
          action: "clockOutWithOpenCashSession",
          message: `ออกงานขณะรอบเงินสดยังเปิด — ยังมีคนลงเวลาอยู่ ${othersOnShift} คน (คนสุดท้ายต้องปิดรอบ)`,
          organizationId: ctx.organizationId,
          storeId: recordStoreId,
          actorUserId: user.id,
          context: { attendanceRecordId: active.id, cashSessionId: openSession.data.id, othersOnShift, shiftDate: active.date },
        }).catch(() => undefined);
      }
    }

    // ผู้รับผิดชอบเช็กลิสต์ที่ตั้ง "ต้องเสร็จก่อนออกงาน" ต้องส่งก่อน (ทุก role — ตามที่เจ้าของมอบหมาย)
    const checklistBlock = await checkClockOutChecklistGate({
      organizationId: ctx.organizationId,
      storeId: recordStoreId,
      userId: user.id,
      shiftDate: active.date,
    });
    if (checklistBlock) return { error: checklistBlock };

    const gpsPolicy = await getAttendanceGpsPolicy(recordStoreId, ctx.organizationId);
    const locationAllowed = gpsPolicy.gpsEnabled;
    const latRaw = formData.get("lat") as string | null;
    const lngRaw = formData.get("lng") as string | null;
    const accuracyRaw = formData.get("accuracy") as string | null;
    const locationLabel = locationAllowed
      ? (formData.get("locationLabel") as string | null)?.trim() || undefined
      : undefined;
    const note = (formData.get("note") as string | null)?.trim() || undefined;

    const location = parseClockLocation(
      { lat: latRaw, lng: lngRaw, accuracy: accuracyRaw, locationLabel },
      locationAllowed,
    );
    const gpsPolicyError = validateAttendanceGpsPolicy(location, gpsPolicy);
    if (gpsPolicyError) return { error: gpsPolicyError };

    const result = await clockOut(active.id, recordStoreId, user.id, {
      clockOutAt: now.toISOString(),
      lat: location.lat,
      lng: location.lng,
      locationLabel: location.locationLabel,
      note,
    });

    if (result.error) return { error: result.error.userMessage };
    if (leftWithOpenCashSessionId) {
      // ตรวจซ้ำหลังออก: สองคนกดออกพร้อมกันอาจเห็นกันและกันจนไม่มีใครปิดรอบ — บันทึกเตือนให้ตามปิด
      const remaining = await countOpenShiftsInStore({
        storeId: recordStoreId,
        organizationId: ctx.organizationId,
        date: active.date,
        excludeRecordId: active.id,
        clockedInSince: recentShiftSince,
      });
      if (remaining === 0) {
        await logSystemEvent({
          level: "warn",
          source: "attendance.clock-out",
          action: "cashSessionLeftOpen",
          message: "ทุกคนออกงานแล้วแต่รอบเงินสดยังเปิดค้าง (ออกพร้อมกัน) — ต้องมีคนเปิด POS ปิดรอบ",
          organizationId: ctx.organizationId,
          storeId: recordStoreId,
          actorUserId: user.id,
          context: { attendanceRecordId: active.id, cashSessionId: leftWithOpenCashSessionId, shiftDate: active.date },
        }).catch(() => undefined);
      }
    }
    if (result.data) {
      notifyOwnerSafely({
        type: "attendance_clock_out",
        organizationId: ctx.organizationId,
        storeId: recordStoreId,
        title: "พนักงานออกงาน",
        message: `${result.data.employeeName} ออกงาน เวลา ${formatClockNotificationTime(result.data.clockOutAt ?? now.toISOString(), ctx.storeTimezone)}`,
        metadata: {
          attendanceRecordId: result.data.id,
          userId: result.data.userId,
          action: "clock_out",
          date: result.data.date,
          clockInAt: result.data.clockInAt,
          clockOutAt: result.data.clockOutAt ?? null,
          locationLabel: result.data.clockOutLocationLabel ?? null,
        },
      });

      const recordStore = await getStore(recordStoreId);
      if (recordStore.error || !recordStore.data?.timezone) {
        await logSystemEvent({
          level: "warn",
          source: "attendance.daily-summary",
          action: "getRecordStoreTimezone",
          message: "อ่าน timezone ของสาขาที่ออกงานไม่ได้ — ข้ามสรุปยอดเพื่อไม่ดึงข้อมูลผิดวัน",
          organizationId: ctx.organizationId,
          storeId: recordStoreId,
          context: { attendanceRecordId: result.data.id, date: result.data.date },
        });
        return { error: null };
      }

      notifyDailySummaryAfterClockOut({
        organizationId: ctx.organizationId,
        storeId: recordStoreId,
        timezone: recordStore.data.timezone,
        employeeName: result.data.employeeName,
        date: result.data.date,
        attendanceRecordId: result.data.id,
      });
    }

    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

function readOptionalNumber(formData: FormData, key: string) {
  const raw = (formData.get(key) as string | null)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

export async function saveAttendanceSettingsAction(
  _prev: { error: string | null; success?: boolean },
  formData: FormData,
): Promise<{ error: string | null; success?: boolean }> {
  try {
    await requirePermission("attendance.manage");
    const { ctx } = await getStoreContext();

    const geofenceEnabled = formData.get("geofenceEnabled") === "on";
    const geofenceCenterLat = readOptionalNumber(formData, "geofenceCenterLat");
    const geofenceCenterLng = readOptionalNumber(formData, "geofenceCenterLng");
    const geofenceRadiusMeters = readOptionalNumber(formData, "geofenceRadiusMeters");

    if (
      geofenceEnabled &&
      (
        geofenceCenterLat === undefined ||
        geofenceCenterLng === undefined ||
        geofenceRadiusMeters === undefined ||
        Number.isNaN(geofenceCenterLat) ||
        Number.isNaN(geofenceCenterLng) ||
        Number.isNaN(geofenceRadiusMeters) ||
        geofenceCenterLat < -90 ||
        geofenceCenterLat > 90 ||
        geofenceCenterLng < -180 ||
        geofenceCenterLng > 180 ||
        geofenceRadiusMeters < 10 ||
        geofenceRadiusMeters > 5000
      )
    ) {
      return { error: "กรุณาตั้งค่า center/radius ของพื้นที่เข้างานให้ถูกต้อง" };
    }

    const savedCenterLat = geofenceEnabled ? geofenceCenterLat : undefined;
    const savedCenterLng = geofenceEnabled ? geofenceCenterLng : undefined;
    const savedRadiusMeters =
      geofenceEnabled && geofenceRadiusMeters !== undefined
        ? Math.round(geofenceRadiusMeters)
        : undefined;

    const result = await upsertAttendanceSettings({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      geofenceEnabled,
      geofenceCenterLat: savedCenterLat,
      geofenceCenterLng: savedCenterLng,
      geofenceRadiusMeters: savedRadiusMeters,
    });

    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/attendance", "page");
    return { error: null, success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** Set which weekdays the store is open (0=Sun .. 6=Sat) — drives the attendance calendar default. */
export async function saveStoreWorkingDaysAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { ctx } = await getStoreContext();
    const raw = formData.getAll("workingDays").map((v) => Number(String(v)));
    const workingDays = [...new Set(raw)]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    if (workingDays.length === 0) return { error: "ต้องเลือกวันเปิดทำการอย่างน้อย 1 วัน" };
    const result = await updateStoreWorkingDays(ctx.storeId, ctx.organizationId, workingDays);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

// --- Backdated / manual attendance editing (manager) ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a "YYYY-MM-DDTHH:MM" datetime-local value as wall-clock time in the store's timezone and
 * return the matching UTC ISO instant; returns null if invalid. The timezone matters: the input is
 * what the manager typed in store-local time, but the server clock is UTC.
 */
function parseLocalDateTime(raw: unknown, timeZone: string): string | null {
  return storeDateTimeToUtc(String(raw ?? "").trim(), timeZone);
}

function revalidateAttendancePayrollPaths() {
  revalidatePath("/attendance", "page");
  revalidatePath("/staff", "page");
  revalidatePath("/payslip", "page");
}

async function resolveManagedAttendanceMember(
  organizationId: string,
  storeId: string,
  userId: string,
): Promise<{ employeeName: string | null; error: string | null }> {
  const members = await listStoreMemberships(organizationId, storeId);
  if (members.error) return { employeeName: null, error: members.error.userMessage };

  const member = (members.data ?? []).find((m) => m.userId === userId && m.role !== "super_admin");
  if (!member) return { employeeName: null, error: "ไม่พบพนักงานในร้านนี้" };

  return { employeeName: member.email.slice(0, 100), error: null };
}

export async function addManualAttendanceAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { user, ctx } = await getStoreContext();

    const userId = String(formData.get("userId") ?? "");
    if (!UUID_RE.test(userId)) return { error: "พนักงานไม่ถูกต้อง" };
    const member = await resolveManagedAttendanceMember(ctx.organizationId, ctx.storeId, userId);
    if (member.error || !member.employeeName) return { error: member.error ?? "พนักงานไม่ถูกต้อง" };
    const date = String(formData.get("date") ?? "").trim();
    if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return { error: "วันที่ไม่ถูกต้อง" };

    const clockInAt = parseLocalDateTime(formData.get("clockInAt"), ctx.storeTimezone);
    if (!clockInAt) return { error: "เวลาเข้าไม่ถูกต้อง" };
    const clockOutRaw = String(formData.get("clockOutAt") ?? "").trim();
    const clockOutAt = clockOutRaw ? parseLocalDateTime(clockOutRaw, ctx.storeTimezone) : null;
    if (clockOutRaw && !clockOutAt) return { error: "เวลาออกไม่ถูกต้อง" };
    if (clockOutAt && Date.parse(clockOutAt) <= Date.parse(clockInAt)) {
      return { error: "เวลาออกต้องหลังเวลาเข้า" };
    }
    const note = (String(formData.get("note") ?? "")).trim().slice(0, 200) || undefined;

    // วันนั้นมีแถว "ลืมกดออกงาน" อยู่แล้ว → แก้แถวเดิมแทนการเพิ่มแถวซ้อน
    const openRow = await findOpenRecordForDay(ctx.organizationId, userId, date);
    if (openRow) {
      const adjusted = await adjustAttendanceRecord(openRow.id, openRow.storeId, {
        clockInAt,
        clockOutAt,
        note: note ?? openRow.note ?? undefined,
        adjustedByUserId: user.id,
      });
      if (adjusted.error) return { error: adjusted.error.userMessage };
      revalidatePath("/attendance", "page");
      return { error: null };
    }

    const result = await addManualAttendance({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      userId,
      employeeName: member.employeeName,
      date,
      clockInAt,
      clockOutAt,
      note,
      adjustedByUserId: user.id,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function adjustAttendanceAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { user, ctx } = await getStoreContext();

    const id = String(formData.get("id") ?? "");
    if (!UUID_RE.test(id)) return { error: "รายการไม่ถูกต้อง" };
    const clockInAt = parseLocalDateTime(formData.get("clockInAt"), ctx.storeTimezone);
    if (!clockInAt) return { error: "เวลาเข้าไม่ถูกต้อง" };
    const clockOutRaw = String(formData.get("clockOutAt") ?? "").trim();
    const clockOutAt = clockOutRaw ? parseLocalDateTime(clockOutRaw, ctx.storeTimezone) : null;
    if (clockOutRaw && !clockOutAt) return { error: "เวลาออกไม่ถูกต้อง" };
    if (clockOutAt && Date.parse(clockOutAt) <= Date.parse(clockInAt)) {
      return { error: "เวลาออกต้องหลังเวลาเข้า" };
    }
    const note = (String(formData.get("note") ?? "")).trim().slice(0, 200) || undefined;

    const result = await adjustAttendanceRecord(id, ctx.storeId, {
      clockInAt,
      clockOutAt,
      note,
      adjustedByUserId: user.id,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/**
 * พนักงานยื่นคำขอลงเวลาย้อนหลัง (ยังไม่มีผลจนกว่าผู้จัดการอนุมัติ)
 * - recordId = แถวที่ลืมกดออกงาน → ขอแค่เวลาออก (เวลาเข้าใช้ของเดิม ไม่สร้างแถวซ้อน)
 * - ไม่มี recordId = วันที่ไม่ได้ลงเวลาเลย → ขอทั้งเวลาเข้า-ออก
 * สิทธิต่อเดือน/กันทับซ้อน/ตรวจเวลา ทำใน RPC request_attendance_backdate
 */
export async function selfBackdatedClockAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.clock");
    const { user, ctx } = await getStoreContext();

    const recordId = String(formData.get("recordId") ?? "").trim();
    if (recordId && !UUID_RE.test(recordId)) return { error: "รายการไม่ถูกต้อง" };
    const clockOutAt = parseLocalDateTime(formData.get("clockOutAt"), ctx.storeTimezone);
    if (!clockOutAt) return { error: "กรุณาระบุเวลาออก" };

    let date: string | null = null;
    let clockInAt: string | null = null;
    if (!recordId) {
      date = String(formData.get("date") ?? "").trim();
      if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return { error: "วันที่ไม่ถูกต้อง" };
      if (date >= getStoreLocalDate(ctx.storeTimezone)) return { error: "ลงย้อนหลังได้เฉพาะวันที่ผ่านมาแล้ว" };
      clockInAt = parseLocalDateTime(formData.get("clockInAt"), ctx.storeTimezone);
      if (!clockInAt) return { error: "เวลาเข้าไม่ถูกต้อง" };
    }
    const note = (String(formData.get("note") ?? "")).trim().slice(0, 200) || null;

    const result = await submitBackdateRequest({
      storeId: ctx.storeId,
      recordId: recordId || null,
      date,
      clockInAt,
      clockOutAt,
      note,
    });
    if (result.error || !result.id) {
      await logSystemEvent({
        level: "warn", source: "attendance.backdate", action: "requestBackdate",
        message: "ยื่นคำขอลงเวลาย้อนหลังไม่สำเร็จ",
        organizationId: ctx.organizationId, storeId: ctx.storeId, actorUserId: user.id,
        context: { recordId: recordId || null, date, clockOutAt, error: result.rawError ?? result.error },
      });
      return { error: result.error ?? "ส่งคำขอไม่สำเร็จ" };
    }
    await logSystemEvent({
      level: "info", source: "attendance.backdate", action: "requestBackdate",
      message: recordId ? "ยื่นคำขอเวลาออกย้อนหลัง (ลืมกดออกงาน)" : "ยื่นคำขอลงเวลาย้อนหลังทั้งวัน",
      organizationId: ctx.organizationId, storeId: ctx.storeId, actorUserId: user.id,
      context: { requestId: result.id, recordId: recordId || null, date, clockOutAt },
    });

    const requesterName = (user.email ?? user.id).slice(0, 100);
    notifyOwnerSafely({
      type: "approval",
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      title: "คำขออนุมัติใหม่",
      message: recordId
        ? `${requesterName} ขอลงเวลาออกย้อนหลัง (ลืมกดออกงาน) — รออนุมัติในหน้าลงเวลา`
        : `${requesterName} ขอลงเวลาย้อนหลังวันที่ ${date} — รออนุมัติในหน้าลงเวลา`,
      metadata: { employeeName: requesterName, date, kind: "backdated_clock", requestId: result.id },
    });

    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

/** ผู้จัดการอนุมัติ/ปฏิเสธ หรือพนักงานยกเลิกคำขอของตัวเอง (สิทธิ์ตรวจซ้ำใน RPC) */
export async function decideBackdateRequestAction(
  requestId: string,
  action: "approve" | "reject" | "cancel",
  note?: string,
): Promise<{ error: string | null }> {
  try {
    if (action === "cancel") await requirePermission("attendance.clock");
    else await requirePermission("attendance.manage");
    const { user, ctx } = await getStoreContext();
    if (!UUID_RE.test(requestId)) return { error: "รายการไม่ถูกต้อง" };
    if (!["approve", "reject", "cancel"].includes(action)) return { error: "คำสั่งไม่ถูกต้อง" };

    const result = await decideBackdateRequest({ requestId, action, note: note?.trim().slice(0, 200) || null });
    await logSystemEvent({
      level: result.error ? "warn" : "info",
      source: "attendance.backdate",
      action: `decideBackdate.${action}`,
      message: result.error
        ? "ดำเนินการคำขอลงเวลาย้อนหลังไม่สำเร็จ"
        : action === "approve" ? "อนุมัติคำขอลงเวลาย้อนหลัง" : action === "reject" ? "ปฏิเสธคำขอลงเวลาย้อนหลัง" : "ยกเลิกคำขอลงเวลาย้อนหลัง",
      organizationId: ctx.organizationId, storeId: ctx.storeId, actorUserId: user.id,
      context: { requestId, employee: result.data?.employeeName ?? null, date: result.data?.date ?? null, error: result.rawError ?? result.error },
    });
    if (result.error) return { error: result.error };
    if (action === "approve") revalidateAttendancePayrollPaths();
    else revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

// --- Employee holidays / leave days (manager) ---

export async function addEmployeeLeaveAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { user, ctx } = await getStoreContext();

    const userId = String(formData.get("userId") ?? "");
    if (!UUID_RE.test(userId)) return { error: "พนักงานไม่ถูกต้อง" };
    const member = await resolveManagedAttendanceMember(ctx.organizationId, ctx.storeId, userId);
    if (member.error || !member.employeeName) return { error: member.error ?? "พนักงานไม่ถูกต้อง" };
    const date = String(formData.get("date") ?? "").trim();
    if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return { error: "วันที่ไม่ถูกต้อง" };
    const note = (String(formData.get("note") ?? "")).trim().slice(0, 200) || "วันหยุดพนักงาน";

    const result = await addPayrollAdjustment({
      storeId: ctx.storeId,
      organizationId: ctx.organizationId,
      userId,
      employeeName: member.employeeName,
      date,
      type: "leave",
      amount: 0,
      note,
      createdByUserId: user.id,
    });
    if (result.error) return { error: result.error.userMessage };

    revalidateAttendancePayrollPaths();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteEmployeeLeaveAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "รายการไม่ถูกต้อง" };

    const result = await deletePayrollAdjustment(id, ctx.storeId, "leave");
    if (result.error) return { error: result.error.userMessage };

    revalidateAttendancePayrollPaths();
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

// --- Store holidays (owner/admin only) ---

export async function addHolidayAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const { user, ctx } = await getStoreContext();
    const date = String(formData.get("date") ?? "").trim();
    if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return { error: "วันที่ไม่ถูกต้อง" };
    const name = (String(formData.get("name") ?? "")).trim().slice(0, 100) || undefined;
    const result = await addStoreHoliday(ctx.storeId, ctx.organizationId, date, name, user.id);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteHolidayAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("settings.manage_store");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "รายการไม่ถูกต้อง" };
    const result = await deleteStoreHoliday(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function deleteAttendanceAction(id: string): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.manage");
    const { ctx } = await getStoreContext();
    if (!UUID_RE.test(id)) return { error: "รายการไม่ถูกต้อง" };
    const result = await deleteAttendanceRecord(id, ctx.storeId);
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}
