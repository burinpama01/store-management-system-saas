import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeDayStatuses, employmentWindow, resignedBefore, type DayStatus } from "@/modules/attendance/calendar";
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

describe("attendance manager employee leave and feedback UX", () => {
  it("wires employee leave controls through attendance page/actions and shows visible button feedback", () => {
    const root = process.cwd();
    const manager = readFileSync(join(root, "src/app/(dashboard)/attendance/AttendanceManager.tsx"), "utf8");
    const actions = readFileSync(join(root, "src/app/(dashboard)/attendance/actions.ts"), "utf8");
    const page = readFileSync(join(root, "src/app/(dashboard)/attendance/page.tsx"), "utf8");
    const calendar = readFileSync(join(root, "src/app/(dashboard)/attendance/AttendanceCalendar.tsx"), "utf8");

    expect(page).toContain("listPayrollAdjustments");
    expect(page).toContain("leaveAdjustments={leaveAdjustments}");

    expect(actions).toContain("addEmployeeLeaveAction");
    expect(actions).toContain("deleteEmployeeLeaveAction");
    expect(actions).toContain('type: "leave"');
    expect(actions).toContain("amount: 0");

    expect(manager).toContain("actionNotice");
    expect(manager).toContain('aria-live="polite"');
    expect(manager).toContain("วันลาพนักงาน");
    expect(manager).toContain("addEmployeeLeaveAction");
    expect(manager).toContain("deleteEmployeeLeaveAction");
    expect(manager).toContain("employeeLeaveDates={leaveAdjustments}");
    expect(manager).toContain("เพิ่มวันลาพนักงานแล้ว");
    expect(manager).toContain("ลบวันลาพนักงานแล้ว");
    expect(manager).toContain("บันทึกการตั้งค่า GPS เข้างานแล้ว");

    expect(calendar).toContain("employeeLeaveDates");
    expect(calendar).toContain("วันลาพนักงาน");
  });
});

describe("ช่วงที่เป็นพนักงาน (เริ่มงาน/ลาออก)", () => {
  it("ก่อนวันเริ่มงานไม่ฟ้องขาด · หลังวันเริ่มงานยังฟ้องตามปกติ", () => {
    const s = run({ employedFrom: "2026-06-10" });
    expect(s.get("2026-06-01")).toBe("off"); // จันทร์ก่อนเริ่มงาน
    expect(s.get("2026-06-09")).toBe("off");
    expect(s.get("2026-06-10")).toBe("absent"); // พุธ วันเริ่มงานแต่ไม่มา
  });

  it("หลังวันออกงานไม่ฟ้องขาด · วันออกงานยังนับ", () => {
    const s = run({ employedTo: "2026-06-10" });
    expect(s.get("2026-06-10")).toBe("absent");
    expect(s.get("2026-06-11")).toBe("off");
    expect(s.get("2026-06-29")).toBe("off");
  });

  it("มีลงเวลานอกช่วง (มาก่อนวันเริ่มงาน) ยังแสดงตามจริง", () => {
    const s = run({ employedFrom: "2026-06-10", records: [rec("2026-06-08", "2026-06-08T02:00:00Z", "2026-06-08T10:00:00Z")] });
    expect(s.get("2026-06-08")).toBe("completed");
  });

  it("วันหยุด/ลาก่อนวันเริ่มงานก็ไม่มาร์ก", () => {
    const s = run({ employedFrom: "2026-06-10", holidays: new Set(["2026-06-03"]), leaveDates: new Set(["2026-06-04"]) });
    expect(s.get("2026-06-03")).toBe("off");
    expect(s.get("2026-06-04")).toBe("off");
  });

  it("employmentWindow: เริ่ม = วันที่ช้ากว่าระหว่างวันเริ่มงานกับวันเข้าร่วมร้าน (เวลาไทย) · จบ = วันออกงาน", () => {
    // เข้าร่วม 2026-11-08 18:30 UTC = 9 พ.ย. เวลาไทย
    expect(employmentWindow(null, "2026-11-08T18:30:00Z", TZ)).toEqual({ from: "2026-11-09", to: null });
    expect(employmentWindow({ seniorityStartDate: "2026-11-11" }, "2026-11-08T18:30:00Z", TZ).from).toBe("2026-11-11");
    // พนักงานเดิมที่ตั้งวันเริ่มงานย้อนหลัง แต่เพิ่งมีบัญชี → ก่อนมีบัญชีไม่ฟ้องขาด
    expect(employmentWindow({ seniorityStartDate: "2024-01-01" }, "2026-11-08T18:30:00Z", TZ).from).toBe("2026-11-09");
    expect(employmentWindow({ seniorityStartDate: "2024-01-01", employmentEndDate: "2026-11-05" }, null, TZ)).toEqual({ from: "2024-01-01", to: "2026-11-05" });
  });

  it("employmentWindow: ไม่มีข้อมูล/วันเข้าร่วมผิดรูปแบบ = ไม่จำกัด", () => {
    expect(employmentWindow(null, null, TZ)).toEqual({ from: null, to: null });
    expect(employmentWindow(null, "not-a-date", TZ)).toEqual({ from: null, to: null });
  });

  it("resignedBefore: ลาออกก่อนวันที่ดู = ซ่อน", () => {
    expect(resignedBefore("2026-10-31", "2026-11-01")).toBe(true);
    expect(resignedBefore("2026-11-01", "2026-11-01")).toBe(false);
    expect(resignedBefore(null, "2026-11-01")).toBe(false);
  });

  it("หน้าลงเวลา: ส่งช่วงเป็นพนักงานเข้าปฏิทินทีม และซ่อนคนลาออกก่อนช่วงที่ดู", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(dashboard)/attendance/page.tsx"), "utf8");
    expect(src).toContain("employmentWindow(allProfiles.find((p) => p.userId === m.userId), m.joinedAt, ctx.storeTimezone)");
    expect(src).toContain("!resignedBefore(windowByUser.get(m.userId)?.to, dateFrom) || hasRecordInRange.has(m.userId)");
    expect(src).toContain("employedFrom: windowByUser.get(member.userId)?.from ?? null");
    // ปฏิทินของตัวเองใช้สูตรเดียวกับปฏิทินทีม
    expect(src).toContain("employmentWindow(ownProfile, myMembership?.joined_at ?? null, ctx.storeTimezone)");
    expect(src).toContain("prev.storeId === null && m.storeId !== null");
    const staff = readFileSync(join(process.cwd(), "src/app/(dashboard)/staff/StaffManager.tsx"), "utf8");
    expect(staff).toContain("showResigned || !isResigned(m.userId)");
  });
});
