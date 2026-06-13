import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeDayStatuses, type DayStatus } from "@/modules/attendance/calendar";
import type { AttendanceRecord } from "@/modules/attendance/types";

const TZ = "Asia/Bangkok"; // UTC+7

function rec(date: string, inUtc: string, outUtc: string | null, status: AttendanceRecord["status"] = "completed"): AttendanceRecord {
  return {
    id: `${date}-${inUtc}`,
    storeId: "s",
    organizationId: "o",
    userId: "u",
    employeeName: "Alice",
    date,
    clockInAt: inUtc,
    clockOutAt: outUtc,
    status,
    createdAt: "",
    updatedAt: "",
  };
}

function run(over: Partial<Parameters<typeof computeDayStatuses>[0]> = {}): Map<string, DayStatus> {
  return computeDayStatuses({
    month: "2026-06",
    today: "2026-06-30",
    timezone: TZ,
    records: [],
    profile: { expectedStartTime: "09:00", lateGraceMinutes: 5, workingDays: [1, 2, 3, 4, 5] },
    holidays: new Set(),
    leaveDates: new Set(),
    ...over,
  });
}

describe("computeDayStatuses (attendance calendar)", () => {
  it("marks a holiday day off (no record)", () => {
    const s = run({ holidays: new Set(["2026-06-01"]) }); // Mon
    expect(s.get("2026-06-01")).toBe("holiday");
  });

  it("marks a leave day", () => {
    const s = run({ leaveDates: new Set(["2026-06-02"]) }); // Tue
    expect(s.get("2026-06-02")).toBe("leave");
  });

  it("marks a past working day with no record as absent", () => {
    const s = run(); // 2026-06-01 is Monday, in the past relative to today 06-30
    expect(s.get("2026-06-01")).toBe("absent");
  });

  it("does not mark weekends or future days as absent", () => {
    const s = run({ today: "2026-06-10" });
    expect(s.get("2026-06-06")).toBe("off"); // Saturday
    expect(s.get("2026-06-07")).toBe("off"); // Sunday
    expect(s.get("2026-06-15")).toBe("off"); // future Monday
  });

  it("completed = clocked in on time and out", () => {
    // 08:30 local (=01:30Z) before 09:00+5 → on time; out present
    const s = run({ records: [rec("2026-06-01", "2026-06-01T01:30:00Z", "2026-06-01T10:00:00Z")] });
    expect(s.get("2026-06-01")).toBe("completed");
  });

  it("late = clocked in after expected start + grace", () => {
    // 09:30 local (=02:30Z) > 09:05 → late
    const s = run({ records: [rec("2026-06-01", "2026-06-01T02:30:00Z", "2026-06-01T10:00:00Z")] });
    expect(s.get("2026-06-01")).toBe("late");
  });

  it("in_no_out = clocked in but no clock-out", () => {
    const s = run({ records: [rec("2026-06-01", "2026-06-01T01:30:00Z", null, "active")] });
    expect(s.get("2026-06-01")).toBe("in_no_out");
  });

  it("working on a holiday still reflects attendance, not the holiday", () => {
    const s = run({
      holidays: new Set(["2026-06-01"]),
      records: [rec("2026-06-01", "2026-06-01T01:30:00Z", "2026-06-01T10:00:00Z")],
    });
    expect(s.get("2026-06-01")).toBe("completed");
  });
});

describe("store_holidays migration + admin gate", () => {
  it("owner/admin-only RLS + actions enforce settings.manage_store", () => {
    const root = process.cwd();
    const mig = readFileSync(join(root, "supabase/migrations/20260607000007_store_holidays.sql"), "utf8");
    expect(mig).toContain("create table if not exists store_holidays");
    expect(mig).toContain("store_holidays: admin+ can write");
    expect(mig).toContain("auth_user_role_in_store(organization_id, store_id, 'admin')");

    const actions = readFileSync(join(root, "src/app/(dashboard)/attendance/actions.ts"), "utf8");
    expect(actions).toContain("addHolidayAction");
    expect(actions).toContain('requirePermission("settings.manage_store")');
  });
});
