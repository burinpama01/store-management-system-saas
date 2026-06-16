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
  getTodayRecord,
  clockIn,
  clockOut,
  getAttendanceSettings,
  upsertAttendanceSettings,
  addManualAttendance,
  adjustAttendanceRecord,
  deleteAttendanceRecord,
  countSelfBackdated,
  nextMonthStart,
  addStoreHoliday,
  deleteStoreHoliday,
} from "@/modules/attendance/repository";
import {
  addPayrollAdjustment,
  deletePayrollAdjustment,
  getStoreHrSettings,
} from "@/modules/hr/repository";
import { listStoreMemberships } from "@/modules/settings/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { parseClockLocation, validateAttendanceGpsPolicy } from "@/modules/attendance/policy";
import type { AttendanceGpsPolicy } from "@/modules/attendance/policy";

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
  if (
    !settings?.geofenceEnabled ||
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

export async function clockInAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.clock");
    const { user, ctx } = await getStoreContext();

    const now = new Date();
    const today = getStoreLocalDate(ctx.storeTimezone, now);

    const existing = await getTodayRecord(user.id, ctx.organizationId, ctx.storeId, today);
    if (existing) return { error: "คุณได้ลงชื่อเข้างานแล้ว" };

    const gpsPolicy = await getAttendanceGpsPolicy(ctx.storeId, ctx.organizationId);
    const locationAllowed = gpsPolicy.gpsEnabled;
    const latRaw = formData.get("lat") as string | null;
    const lngRaw = formData.get("lng") as string | null;
    const locationLabel = locationAllowed
      ? (formData.get("locationLabel") as string | null)?.trim() || undefined
      : undefined;
    const note = (formData.get("note") as string | null)?.trim() || undefined;

    const location = parseClockLocation({ lat: latRaw, lng: lngRaw, locationLabel }, locationAllowed);
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

    revalidatePath("/attendance", "page");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "เกิดข้อผิดพลาด" };
  }
}

export async function clockOutAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.clock");
    const { user, ctx } = await getStoreContext();

    const now = new Date();
    const today = getStoreLocalDate(ctx.storeTimezone, now);
    const active = await getTodayRecord(user.id, ctx.organizationId, ctx.storeId, today);
    if (!active) return { error: "ไม่พบรายการที่รอลงชื่อออก" };

    const gpsPolicy = await getAttendanceGpsPolicy(ctx.storeId, ctx.organizationId);
    const locationAllowed = gpsPolicy.gpsEnabled;
    const latRaw = formData.get("lat") as string | null;
    const lngRaw = formData.get("lng") as string | null;
    const locationLabel = locationAllowed
      ? (formData.get("locationLabel") as string | null)?.trim() || undefined
      : undefined;
    const note = (formData.get("note") as string | null)?.trim() || undefined;

    const location = parseClockLocation({ lat: latRaw, lng: lngRaw, locationLabel }, locationAllowed);
    const gpsPolicyError = validateAttendanceGpsPolicy(location, gpsPolicy);
    if (gpsPolicyError) return { error: gpsPolicyError };

    const result = await clockOut(active.id, ctx.storeId, user.id, {
      clockOutAt: now.toISOString(),
      lat: location.lat,
      lng: location.lng,
      locationLabel: location.locationLabel,
      note,
    });

    if (result.error) return { error: result.error.userMessage };

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

// --- Backdated / manual attendance editing (manager) ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse "YYYY-MM-DDTHH:MM" local input into an ISO timestamp; returns null if invalid. */
function parseLocalDateTime(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (isNaN(t)) return null;
  return new Date(t).toISOString();
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

    const clockInAt = parseLocalDateTime(formData.get("clockInAt"));
    if (!clockInAt) return { error: "เวลาเข้าไม่ถูกต้อง" };
    const clockOutRaw = String(formData.get("clockOutAt") ?? "").trim();
    const clockOutAt = clockOutRaw ? parseLocalDateTime(clockOutRaw) : null;
    if (clockOutRaw && !clockOutAt) return { error: "เวลาออกไม่ถูกต้อง" };
    if (clockOutAt && Date.parse(clockOutAt) <= Date.parse(clockInAt)) {
      return { error: "เวลาออกต้องหลังเวลาเข้า" };
    }
    const note = (String(formData.get("note") ?? "")).trim().slice(0, 200) || undefined;

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
    const clockInAt = parseLocalDateTime(formData.get("clockInAt"));
    if (!clockInAt) return { error: "เวลาเข้าไม่ถูกต้อง" };
    const clockOutRaw = String(formData.get("clockOutAt") ?? "").trim();
    const clockOutAt = clockOutRaw ? parseLocalDateTime(clockOutRaw) : null;
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

/** Employee self-service backdated clock for a missed day, limited to N/month. */
export async function selfBackdatedClockAction(formData: FormData): Promise<{ error: string | null }> {
  try {
    await requirePermission("attendance.clock");
    const { user, ctx } = await getStoreContext();

    const date = String(formData.get("date") ?? "").trim();
    if (!DATE_RE.test(date) || isNaN(Date.parse(date))) return { error: "วันที่ไม่ถูกต้อง" };

    const today = getStoreLocalDate(ctx.storeTimezone);
    if (date >= today) return { error: "ลงย้อนหลังได้เฉพาะวันที่ผ่านมาแล้ว" };

    const clockInAt = parseLocalDateTime(formData.get("clockInAt"));
    if (!clockInAt) return { error: "เวลาเข้าไม่ถูกต้อง" };
    const clockOutRaw = String(formData.get("clockOutAt") ?? "").trim();
    const clockOutAt = clockOutRaw ? parseLocalDateTime(clockOutRaw) : null;
    if (clockOutRaw && !clockOutAt) return { error: "เวลาออกไม่ถูกต้อง" };
    if (clockOutAt && Date.parse(clockOutAt) <= Date.parse(clockInAt)) {
      return { error: "เวลาออกต้องหลังเวลาเข้า" };
    }

    const settings = await getStoreHrSettings(ctx.storeId, ctx.organizationId);
    const monthStart = date.slice(0, 7) + "-01";
    const used = await countSelfBackdated(user.id, ctx.storeId, monthStart, nextMonthStart(date));
    if (used >= settings.backdatedRightsPerMonth) {
      return { error: `ใช้สิทธิลงเวลาย้อนหลังครบ ${settings.backdatedRightsPerMonth} ครั้งในเดือนนี้แล้ว` };
    }

    const result = await addManualAttendance({
      organizationId: ctx.organizationId,
      storeId: ctx.storeId,
      userId: user.id,
      employeeName: (user.email ?? user.id).slice(0, 100),
      date,
      clockInAt,
      clockOutAt,
      note: (String(formData.get("note") ?? "")).trim().slice(0, 200) || undefined,
      adjustedByUserId: user.id,
    });
    if (result.error) return { error: result.error.userMessage };
    revalidatePath("/attendance", "page");
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
