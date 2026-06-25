import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computePayrollSummaries } from "@/modules/attendance/repository";
import { getStoreLocalDate } from "@/modules/attendance/date";
import { distanceMeters, isValidGeoPoint, isWithinRadius } from "@/modules/attendance/geo";
import { parseClockLocation, validateAttendanceGpsPolicy } from "@/modules/attendance/policy";
import type { AttendanceRecord } from "@/modules/attendance/types";

const STORE = "store-aaa";
const ORG = "org-bbb";

function rec(
  id: string,
  userId: string,
  date: string,
  clockIn: string,
  clockOut: string | null,
  overrides: Partial<AttendanceRecord> = {},
): AttendanceRecord {
  return {
    id,
    storeId: STORE,
    organizationId: ORG,
    userId,
    employeeName: `Employee ${userId}`,
    date,
    clockInAt: `${date}T${clockIn}:00Z`,
    clockOutAt: clockOut ? `${date}T${clockOut}:00Z` : null,
    status: clockOut ? "completed" : "active",
    createdAt: `${date}T00:00:00Z`,
    updatedAt: `${date}T00:00:00Z`,
    ...overrides,
  };
}

describe("computePayrollSummaries", () => {
  it("empty records → empty summaries", () => {
    const result = computePayrollSummaries([], STORE, ORG, "2026-05-01", "2026-05-31");
    expect(result).toHaveLength(0);
  });

  it("active (no clockOut) records → 0 hours", () => {
    const result = computePayrollSummaries(
      [rec("r1", "u1", "2026-05-01", "08:00", null)],
      STORE, ORG, "2026-05-01", "2026-05-31",
    );
    expect(result).toHaveLength(1);
    expect(result[0].totalHours).toBe(0);
    expect(result[0].regularHours).toBe(0);
    expect(result[0].totalDays).toBe(0);
  });

  it("exactly 8 hours → all regular, no overtime", () => {
    const result = computePayrollSummaries(
      [rec("r1", "u1", "2026-05-01", "08:00", "16:00")],
      STORE, ORG, "2026-05-01", "2026-05-31",
    );
    expect(result[0].totalHours).toBe(8);
    expect(result[0].regularHours).toBe(8);
    expect(result[0].overtimeHours).toBe(0);
    expect(result[0].totalDays).toBe(1);
  });

  it("10 hours in one day → 8h regular + 2h overtime", () => {
    const result = computePayrollSummaries(
      [rec("r1", "u1", "2026-05-01", "08:00", "18:00")],
      STORE, ORG, "2026-05-01", "2026-05-31",
    );
    expect(result[0].totalHours).toBe(10);
    expect(result[0].regularHours).toBe(8);
    expect(result[0].overtimeHours).toBe(2);
  });

  it("two users: sorted by employeeName", () => {
    const result = computePayrollSummaries(
      [
        rec("r1", "u2", "2026-05-01", "08:00", "16:00", { employeeName: "Zon" }),
        rec("r2", "u1", "2026-05-01", "08:00", "16:00", { employeeName: "Alice" }),
      ],
      STORE, ORG, "2026-05-01", "2026-05-31",
    );
    expect(result.map((s) => s.employeeName)).toEqual(["Alice", "Zon"]);
  });

  it("multiple days: regularHours capped at 8h/day per completed day", () => {
    // 3 completed days × 9h each = 27h total
    // regular = min(27, 3 × 8) = 24h; overtime = 3h
    const records = [
      rec("r1", "u1", "2026-05-01", "08:00", "17:00"),
      rec("r2", "u1", "2026-05-02", "08:00", "17:00"),
      rec("r3", "u1", "2026-05-03", "08:00", "17:00"),
    ];
    const result = computePayrollSummaries(records, STORE, ORG, "2026-05-01", "2026-05-31");
    expect(result[0].totalDays).toBe(3);
    expect(result[0].totalHours).toBe(27);
    expect(result[0].regularHours).toBe(24);
    expect(result[0].overtimeHours).toBe(3);
  });

  it("filters out records from wrong store/org", () => {
    const wrongStore = rec("r1", "u1", "2026-05-01", "08:00", "16:00", {
      storeId: "other-store",
    });
    const correctStore = rec("r2", "u2", "2026-05-01", "08:00", "16:00");
    const result = computePayrollSummaries(
      [wrongStore, correctStore],
      STORE, ORG, "2026-05-01", "2026-05-31",
    );
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe("u2");
  });

  it("totalPay is always 0 (no rate column in MVP)", () => {
    const result = computePayrollSummaries(
      [rec("r1", "u1", "2026-05-01", "08:00", "16:00")],
      STORE, ORG, "2026-05-01", "2026-05-31",
    );
    expect(result[0].totalPay).toBe(0);
  });

  it("negative duration (clockOut before clockIn) is ignored", () => {
    const result = computePayrollSummaries(
      [rec("r1", "u1", "2026-05-01", "16:00", "08:00")], // negative
      STORE, ORG, "2026-05-01", "2026-05-31",
    );
    expect(result[0].totalHours).toBe(0);
    expect(result[0].totalDays).toBe(0);
  });
});

describe("attendance GPS policy", () => {
  it("uses the store timezone for today's attendance date", () => {
    const nearBangkokMidnight = new Date("2026-01-01T18:30:00.000Z");
    const dateHelper = readFileSync(join(process.cwd(), "src/modules/attendance/date.ts"), "utf8");
    const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/attendance/page.tsx"), "utf8");
    const actions = readFileSync(join(process.cwd(), "src/app/(dashboard)/attendance/actions.ts"), "utf8");

    expect(getStoreLocalDate("Asia/Bangkok", nearBangkokMidnight)).toBe("2026-01-02");
    expect(getStoreLocalDate("UTC", nearBangkokMidnight)).toBe("2026-01-01");
    expect(getStoreLocalDate("Not/AZone", nearBangkokMidnight)).toBe("2026-01-02");
    expect(dateHelper).toContain("export function getStoreLocalDate");
    expect(dateHelper).toContain("timeZone");
    expect(dateHelper).toContain("DEFAULT_ATTENDANCE_TIME_ZONE");
    expect(page).toContain("getStoreLocalDate(ctx.storeTimezone)");
    expect(actions).toContain("getStoreLocalDate(ctx.storeTimezone, now)");
    expect(actions.match(/getStoreLocalDate\(ctx\.storeTimezone, now\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(actions).toContain("clockOutAt: now.toISOString()");
    expect(page).not.toContain('new Date().toISOString().split("T")[0]');
    expect(actions).not.toContain('new Date().toISOString().split("T")[0]');
  });

  it("computes distance in meters and checks a geofence radius", () => {
    const store = { lat: 13.7563, lng: 100.5018 };
    const nearby = { lat: 13.7564, lng: 100.5019 };
    const far = { lat: 13.7367, lng: 100.5231 };

    expect(distanceMeters(store, nearby)).toBeLessThan(25);
    expect(isWithinRadius(nearby, store, 25)).toBe(true);
    expect(isWithinRadius(far, store, 25)).toBe(false);
  });

  it("rejects invalid geofence points before computing radius", () => {
    expect(isValidGeoPoint({ lat: 999, lng: 100 })).toBe(false);
    expect(isValidGeoPoint({ lat: Number.NaN, lng: 100 })).toBe(false);
    expect(isWithinRadius({ lat: 999, lng: 100 }, { lat: 999, lng: 100 }, 1)).toBe(false);
    expect(isWithinRadius({ lat: 13, lng: 100 }, { lat: 13, lng: Number.POSITIVE_INFINITY }, 1)).toBe(false);
  });

  it("ignores GPS data when the package does not allow location capture", () => {
    const location = parseClockLocation(
      { lat: "13.7563", lng: "100.5018", locationLabel: " หน้าร้าน " },
      false,
    );

    expect(location).toEqual({});
  });

  it("normalizes valid GPS data and rejects partial or out-of-bound coordinates", () => {
    expect(parseClockLocation(
      { lat: "13.7563", lng: "100.5018", locationLabel: " หน้าร้าน " },
      true,
    )).toEqual({ lat: 13.7563, lng: 100.5018, locationLabel: "หน้าร้าน" });

    expect(parseClockLocation({ lat: "13.7563" }, true)).toEqual({});
    expect(parseClockLocation({ lat: "99", lng: "100.5018" }, true)).toEqual({});
    expect(parseClockLocation({ lat: "13.7563abc", lng: "100.5018" }, true)).toEqual({});
    expect(parseClockLocation({ lat: "   ", lng: "100.5018" }, true)).toEqual({});
  });

  it("validates optional geofence policy states", () => {
    const center = { lat: 13.7563, lng: 100.5018 };

    expect(validateAttendanceGpsPolicy({}, { gpsEnabled: false, center, radiusMeters: 20 })).toBeNull();
    // GPS on (geofence enabled) now requires a real captured location even without a center/radius.
    expect(validateAttendanceGpsPolicy({}, { gpsEnabled: true })).toBe("กรุณาอนุญาตตำแหน่งเพื่อบันทึกเวลา");
    expect(validateAttendanceGpsPolicy({ lat: 13.7563, lng: 100.5018 }, { gpsEnabled: true })).toBeNull();
    expect(validateAttendanceGpsPolicy({}, { gpsEnabled: true, center, radiusMeters: 20 })).toBe("กรุณาอนุญาตตำแหน่งเพื่อบันทึกเวลา");
    expect(validateAttendanceGpsPolicy({ lat: 13.7564, lng: 100.5019 }, { gpsEnabled: true, center, radiusMeters: 25 })).toBeNull();
    expect(validateAttendanceGpsPolicy({ lat: 13.7367, lng: 100.5231 }, { gpsEnabled: true, center, radiusMeters: 25 })).toBe("ตำแหน่งอยู่นอกพื้นที่ที่กำหนด");
  });

  it("wires GPS policy validation into clock-in and clock-out actions", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/attendance/actions.ts"),
      "utf8",
    );

    expect(source).toContain("validateAttendanceGpsPolicy");
    expect(source).toContain("const gpsPolicyError = validateAttendanceGpsPolicy");
    expect(source).toContain("if (gpsPolicyError) return { error: gpsPolicyError }");
    expect(source.match(/validateAttendanceGpsPolicy/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("wires store-level attendance geofence settings from DB through actions and UI", () => {
    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations/20260601000007_attendance_settings.sql"),
      "utf8",
    );
    const repository = readFileSync(
      join(process.cwd(), "src/modules/attendance/repository.ts"),
      "utf8",
    );
    const actions = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/attendance/actions.ts"),
      "utf8",
    );
    const page = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/attendance/page.tsx"),
      "utf8",
    );
    const manager = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/attendance/AttendanceManager.tsx"),
      "utf8",
    );

    expect(migration).toContain("create table if not exists attendance_settings");
    expect(migration).toContain("geofence_center_lat");
    expect(migration).toContain("geofence_radius_meters");
    expect(migration).toMatch(/foreign key \(store_id, organization_id\)\s+references stores\(id, organization_id\)/);
    expect(migration).not.toMatch(/for insert/);
    expect(migration).not.toMatch(/for update/);

    expect(repository).toContain("getAttendanceSettings");
    expect(repository).toContain("upsertAttendanceSettings");
    expect(repository).toContain("createSupabaseServiceClient");
    expect(actions).toContain("saveAttendanceSettingsAction");
    expect(actions).toContain("getAttendanceGpsPolicy");
    expect(actions).toContain("getAttendanceSettings(storeId, organizationId)");
    expect(actions).toContain("if (settingsResult.error) throw new Error(settingsResult.error.userMessage);");
    expect(actions).toContain("getAttendanceGpsPolicy(ctx.storeId, ctx.organizationId)");
    expect(page).toContain("attendanceSettings");
    expect(manager).toContain("geofenceEnabled");
    expect(manager).toContain("geofenceRadiusMeters");
  });
});
