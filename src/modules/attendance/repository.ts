import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";
import type { AttendanceRecord, AttendanceSettings, PayrollSummary } from "./types";
import type { Database } from "@/server/integrations/supabase/database.types";

type RecordRow = Database["public"]["Tables"]["attendance_records"]["Row"];
type SettingsRow = Database["public"]["Tables"]["attendance_settings"]["Row"];

function mapRecord(row: RecordRow): AttendanceRecord {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    employeeName: row.employee_name,
    date: row.date,
    clockInAt: row.clock_in_at,
    clockOutAt: row.clock_out_at,
    clockInLat: row.clock_in_lat ?? undefined,
    clockInLng: row.clock_in_lng ?? undefined,
    clockInLocationLabel: row.clock_in_location_label ?? undefined,
    clockOutLat: row.clock_out_lat ?? undefined,
    clockOutLng: row.clock_out_lng ?? undefined,
    clockOutLocationLabel: row.clock_out_location_label ?? undefined,
    status: row.status,
    note: row.note ?? undefined,
    adjustedByUserId: row.adjusted_by_user_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttendanceSettings(row: SettingsRow): AttendanceSettings {
  return {
    id: row.id,
    storeId: row.store_id,
    organizationId: row.organization_id,
    geofenceEnabled: row.geofence_enabled,
    geofenceCenterLat: row.geofence_center_lat ?? undefined,
    geofenceCenterLng: row.geofence_center_lng ?? undefined,
    geofenceRadiusMeters: row.geofence_radius_meters ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTodayRecord(
  userId: string,
  organizationId: string,
  storeId: string,
  today: string,
) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("attendance_records")
    .select("*")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("date", today)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? mapRecord(data) : null;
}

/**
 * Active (not-yet-clocked-out) record for the user today across ALL branches in the org.
 * Clock-out and the attendance page use this so a staff who clocked in at one branch can
 * still clock out even when the app resolves a different default store (cookie lost /
 * mobile vs PC). Clock-out then closes the record using its own store_id.
 */
export async function getActiveRecordToday(
  userId: string,
  organizationId: string,
  today: string,
) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("attendance_records")
    .select("*")
    .eq("user_id", userId)
    .eq("organization_id", organizationId)
    .eq("date", today)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? mapRecord(data) : null;
}

export async function getAttendanceSettings(storeId: string, organizationId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("attendance_settings")
    .select("*")
    .eq("store_id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { data: null, error: mapError(error) };
  return { data: data ? mapAttendanceSettings(data) : null, error: null };
}

export interface UpsertAttendanceSettingsInput {
  storeId: string;
  organizationId: string;
  geofenceEnabled: boolean;
  geofenceCenterLat?: number;
  geofenceCenterLng?: number;
  geofenceRadiusMeters?: number;
}

export async function upsertAttendanceSettings(input: UpsertAttendanceSettingsInput) {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase.from("attendance_settings").upsert(
    {
      store_id: input.storeId,
      organization_id: input.organizationId,
      geofence_enabled: input.geofenceEnabled,
      geofence_center_lat: input.geofenceCenterLat ?? null,
      geofence_center_lng: input.geofenceCenterLng ?? null,
      geofence_radius_meters: input.geofenceRadiusMeters ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export interface ClockInInput {
  userId: string;
  organizationId: string;
  storeId: string;
  employeeName: string;
  date: string;
  clockInAt: string;
  lat?: number;
  lng?: number;
  locationLabel?: string;
  note?: string;
}

export async function clockIn(input: ClockInInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("attendance_records")
    .insert({
      user_id: input.userId,
      organization_id: input.organizationId,
      store_id: input.storeId,
      employee_name: input.employeeName,
      date: input.date,
      clock_in_at: input.clockInAt,
      clock_in_lat: input.lat ?? null,
      clock_in_lng: input.lng ?? null,
      clock_in_location_label: input.locationLabel ?? null,
      note: input.note ?? null,
      status: "active",
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapRecord(data), error: null };
}

export interface ClockOutInput {
  clockOutAt: string;
  lat?: number;
  lng?: number;
  locationLabel?: string;
  note?: string;
}

export async function clockOut(id: string, storeId: string, userId: string, input: ClockOutInput) {
  const supabase = await createSupabaseServerClient();
  // Atomic: only completes records that are still "active" and belong to this user/store.
  const { data, error } = await supabase
    .from("attendance_records")
    .update({
      clock_out_at: input.clockOutAt,
      clock_out_lat: input.lat ?? null,
      clock_out_lng: input.lng ?? null,
      clock_out_location_label: input.locationLabel ?? null,
      note: input.note ?? null,
      status: "completed",
    })
    .eq("id", id)
    .eq("store_id", storeId)
    .eq("user_id", userId)
    .eq("status", "active")
    .select()
    .single();
  if (error || !data)
    return { data: null, error: mapError(error ?? new Error("ไม่พบรายการที่รอลงชื่อออก")) };
  return { data: mapRecord(data), error: null };
}

/** storeId = null → ทุกสาขาในองค์กร (จอผู้จัดการดูรวม เพราะพนักงานลงเวลาคนละสาขากับเครื่องที่เปิดดู) */
export async function listAttendanceRecords(
  organizationId: string,
  storeId: string | null,
  dateFrom: string,
  dateTo: string,
  userId?: string,
) {
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from("attendance_records")
    .select("*")
    .eq("organization_id", organizationId)
    .gte("date", dateFrom)
    .lte("date", dateTo)
    .order("date", { ascending: false })
    .order("clock_in_at", { ascending: false });
  if (storeId) q = q.eq("store_id", storeId);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) return { data: null, error: mapError(error) };
  return { data: (data ?? []).map(mapRecord), error: null };
}

export interface ManualAttendanceInput {
  organizationId: string;
  storeId: string;
  userId: string;
  employeeName: string;
  date: string;
  clockInAt: string;
  clockOutAt: string | null;
  note?: string;
  adjustedByUserId: string;
}

/** Manager adds a backdated attendance record. */
export async function addManualAttendance(input: ManualAttendanceInput) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("attendance_records")
    .insert({
      organization_id: input.organizationId,
      store_id: input.storeId,
      user_id: input.userId,
      employee_name: input.employeeName,
      date: input.date,
      clock_in_at: input.clockInAt,
      clock_out_at: input.clockOutAt,
      note: input.note ?? null,
      status: "backdated",
      adjusted_by_user_id: input.adjustedByUserId,
    })
    .select()
    .single();
  if (error) return { data: null, error: mapError(error) };
  return { data: mapRecord(data), error: null };
}

export interface AdjustAttendanceInput {
  clockInAt: string;
  clockOutAt: string | null;
  note?: string;
  adjustedByUserId: string;
}

/** Manager edits an existing attendance record (correct clock times). */
export async function adjustAttendanceRecord(
  id: string,
  storeId: string,
  input: AdjustAttendanceInput,
) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("attendance_records")
    .update({
      clock_in_at: input.clockInAt,
      clock_out_at: input.clockOutAt,
      note: input.note ?? null,
      status: "adjusted",
      adjusted_by_user_id: input.adjustedByUserId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("store_id", storeId)
    .select()
    .single();
  if (error || !data) return { data: null, error: mapError(error ?? new Error("ไม่พบรายการ")) };
  return { data: mapRecord(data), error: null };
}

/** First day of the month after the one containing `date` (YYYY-MM-DD). Exclusive upper bound. */
export function nextMonthStart(date: string): string {
  const [y, m] = date.slice(0, 7).split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** Count self-service backdated records the user created within a month (rights usage). */
export async function countSelfBackdated(
  userId: string,
  storeId: string,
  monthStart: string,
  monthEndExclusive: string,
): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { count } = await supabase
    .from("attendance_records")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("user_id", userId)
    .eq("adjusted_by_user_id", userId)
    .eq("status", "backdated")
    .gte("date", monthStart)
    .lt("date", monthEndExclusive);
  return count ?? 0;
}

// --- Store holidays (owner/admin) ---

export interface StoreHoliday {
  id: string;
  date: string;
  name?: string;
}

export async function listStoreHolidays(storeId: string, from: string, to: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("store_holidays")
    .select("id, date, name")
    .eq("store_id", storeId)
    .gte("date", from)
    .lte("date", to)
    .order("date");
  if (error) return { data: null, error: mapError(error) };
  return {
    data: (data ?? []).map((h) => ({ id: h.id, date: h.date, name: h.name ?? undefined })) as StoreHoliday[],
    error: null,
  };
}

export async function addStoreHoliday(
  storeId: string,
  organizationId: string,
  date: string,
  name: string | undefined,
  createdByUserId: string,
) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("store_holidays").upsert(
    {
      store_id: storeId,
      organization_id: organizationId,
      date,
      name: name ?? null,
      created_by_user_id: createdByUserId,
    },
    { onConflict: "store_id,date" },
  );
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function deleteStoreHoliday(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("store_holidays").delete().eq("id", id).eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export async function deleteAttendanceRecord(id: string, storeId: string) {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("attendance_records")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

// Computes payroll summaries grouped by userId from a list of records.
// Hours are computed from clock_in_at → clock_out_at; records without clock_out are excluded from hour totals.
export function computePayrollSummaries(
  records: AttendanceRecord[],
  /** null = รวมทุกสาขาในองค์กร (จอผู้จัดการโหมด "ทุกสาขา") */
  storeId: string | null,
  organizationId: string,
  periodStart: string,
  periodEnd: string,
): PayrollSummary[] {
  const byUser = new Map<string, AttendanceRecord[]>();
  for (const r of records) {
    const existing = byUser.get(r.userId);
    if (existing) existing.push(r);
    else byUser.set(r.userId, [r]);
  }

  const summaries: PayrollSummary[] = [];
  for (const [userId, userRecords] of byUser) {
    // Skip records that slipped in from the wrong store/org (ATT-07 defence-in-depth).
    const safeRecords = userRecords.filter(
      (r) => (storeId === null || r.storeId === storeId) && r.organizationId === organizationId,
    );
    if (safeRecords.length === 0) continue;
    const employeeName = safeRecords[0].employeeName;
    let totalMs = 0;
    const completedDates = new Set<string>();
    for (const r of safeRecords) {
      if (r.clockOutAt) {
        const ms = new Date(r.clockOutAt).getTime() - new Date(r.clockInAt).getTime();
        if (ms > 0) {
          totalMs += ms;
          completedDates.add(r.date);
        }
      }
    }
    const totalHours = Math.round((totalMs / 3_600_000) * 100) / 100;
    const totalDays = completedDates.size;
    // Regular = up to 8h/day per completed day; overtime = remainder
    const regularHours = Math.min(totalHours, totalDays * 8);
    const overtimeHours = Math.max(0, totalHours - regularHours);

    summaries.push({
      id: userId,
      storeId: storeId ?? safeRecords[0].storeId,
      organizationId,
      userId,
      employeeName,
      periodStart,
      periodEnd,
      totalDays,
      totalHours,
      regularHours: Math.round(regularHours * 100) / 100,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
      totalPay: 0,
      records: safeRecords,
      generatedAt: new Date().toISOString(),
    });
  }
  return summaries.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}
