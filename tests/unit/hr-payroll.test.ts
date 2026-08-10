import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeBasePay, computePayrollLines } from "@/modules/hr/payroll";
import type { EmployeeProfile, PayrollAdjustment, StoreHrSettings } from "@/modules/hr/types";
import { DEFAULT_HR_SETTINGS } from "@/modules/hr/types";
import type { PayrollSummary, AttendanceRecord } from "@/modules/attendance/types";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

function summary(over: Partial<PayrollSummary> = {}): PayrollSummary {
  return {
    id: "u1",
    storeId: "s1",
    organizationId: "o1",
    userId: "u1",
    employeeName: "Alice",
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    totalDays: 10,
    totalHours: 80,
    regularHours: 80,
    overtimeHours: 0,
    totalPay: 0,
    records: [],
    generatedAt: "2026-06-30T00:00:00Z",
    ...over,
  };
}

function profile(over: Partial<EmployeeProfile> = {}): EmployeeProfile {
  return {
    id: "p1",
    organizationId: "o1",
    storeId: "s1",
    userId: "u1",
    payType: "monthly",
    monthlySalary: 15000,
    dailyRate: 500,
    hourlyRate: 60,
    lateGraceMinutes: 0,
    latePenaltyAmount: 0,
    absentPenaltyAmount: 0,
    workingDays: [1, 2, 3, 4, 5],
    otEligible: true,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function settings(over: Partial<StoreHrSettings> = {}): StoreHrSettings {
  return {
    storeId: "s1",
    organizationId: "o1",
    ...DEFAULT_HR_SETTINGS,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function lines(args: {
  summaries?: PayrollSummary[];
  records?: AttendanceRecord[];
  profiles?: EmployeeProfile[];
  adjustments?: PayrollAdjustment[];
  settings?: StoreHrSettings;
  holidayDates?: string[];
  periodStart?: string;
  periodEnd?: string;
  today?: string;
}) {
  return computePayrollLines({
    summaries: args.summaries ?? [],
    records: args.records ?? [],
    profiles: args.profiles ?? [],
    adjustments: args.adjustments ?? [],
    settings: args.settings ?? settings(),
    holidayDates: args.holidayDates,
    periodStart: args.periodStart ?? "2026-06-01",
    periodEnd: args.periodEnd ?? "2026-06-30",
    today: args.today ?? "2026-06-30",
    timezone: "Asia/Bangkok",
  });
}

function adj(over: Partial<PayrollAdjustment> = {}): PayrollAdjustment {
  return {
    id: "a1",
    organizationId: "o1",
    storeId: "s1",
    userId: "u1",
    employeeName: "Alice",
    date: "2026-06-10",
    type: "penalty",
    amount: 100,
    createdByUserId: "mgr",
    createdAt: "",
    ...over,
  };
}

describe("computeBasePay", () => {
  it("monthly = fixed salary regardless of days", () => {
    expect(computeBasePay(profile({ payType: "monthly", monthlySalary: 15000 }), summary({ totalDays: 5 }))).toBe(15000);
  });
  it("daily = rate × days", () => {
    expect(computeBasePay(profile({ payType: "daily", dailyRate: 500 }), summary({ totalDays: 10 }))).toBe(5000);
  });
  it("hourly = rate × hours", () => {
    expect(computeBasePay(profile({ payType: "hourly", hourlyRate: 60 }), summary({ totalHours: 80 }))).toBe(4800);
  });
  it("no profile = 0", () => {
    expect(computeBasePay(undefined, summary())).toBe(0);
  });
});

describe("computePayrollLines", () => {
  it("combines base pay, bonuses and deductions into net pay", () => {
    const result = lines({
      summaries: [summary({ totalDays: 10, totalHours: 80 })],
      profiles: [profile({ payType: "daily", dailyRate: 500 })],
      adjustments: [adj({ type: "penalty", amount: 200 }), adj({ id: "a2", type: "bonus", amount: 300 })],
    });
    expect(result).toHaveLength(1);
    const l = result[0];
    expect(l.basePay).toBe(5000);
    expect(l.bonusTotal).toBe(300);
    expect(l.deductionTotal).toBe(200);
    expect(l.netPay).toBe(5100);
  });

  it("treats late/leave/absent manual adjustments as deductions", () => {
    const result = lines({
      summaries: [summary()],
      // No fixed schedule → auto-absence is off, so this stays a test of manual adjustments only.
      profiles: [profile({ payType: "monthly", monthlySalary: 10000, workingDays: [] })],
      adjustments: [adj({ type: "late", amount: 50 }), adj({ id: "a2", type: "leave", amount: 100 }), adj({ id: "a3", type: "absent", amount: 500 })],
    });
    expect(result[0].deductionTotal).toBe(650);
    expect(result[0].netPay).toBe(9350);
  });

  it("surfaces an employee that only has adjustments (no attendance)", () => {
    const result = lines({ adjustments: [adj({ userId: "ghost", employeeName: "Bob", type: "bonus", amount: 100 })] });
    expect(result).toHaveLength(1);
    expect(result[0].employeeName).toBe("Bob");
    expect(result[0].basePay).toBe(0);
    expect(result[0].netPay).toBe(100);
    expect(result[0].hasProfile).toBe(false);
  });

  it("auto-computes OT pay from records over the daily threshold (capped)", () => {
    // One 11h day: 3h over 8h threshold, capped at 2h × 1.5 × ฿60 = ฿180
    const rec: AttendanceRecord = {
      id: "r1", storeId: "s1", organizationId: "o1", userId: "u1", employeeName: "Alice",
      date: "2026-06-02", clockInAt: "2026-06-02T01:00:00Z", clockOutAt: "2026-06-02T12:00:00Z",
      status: "completed", createdAt: "", updatedAt: "",
    };
    const result = lines({
      summaries: [summary({ totalDays: 1, totalHours: 11 })],
      records: [rec],
      profiles: [profile({ payType: "hourly", hourlyRate: 60 })],
      settings: settings({ regularHoursPerDay: 8, otDailyCapHours: 2, otMultiplier: 1.5 }),
    });
    expect(result[0].otHours).toBe(2);
    expect(result[0].otPay).toBe(180);
  });

  it("auto-computes absent penalty for scheduled working days with no record", () => {
    const result = lines({
      profiles: [profile({ payType: "monthly", monthlySalary: 0, workingDays: [1] })], // Mondays only
      settings: settings({ absentPenaltyPerDay: 300 }),
      periodStart: "2026-06-01", // Mon 6/1, 6/8, 6/15, 6/22, 6/29 = 5 Mondays
      periodEnd: "2026-06-30",
      today: "2026-06-30",
    });
    expect(result[0].absentDays).toBe(5);
    expect(result[0].absentPenalty).toBe(1500);
    expect(result[0].netPay).toBe(-1500);
  });

  it("pro-rates a monthly salary by the absent day and skips leave/holiday days", () => {
    const workedDates = [
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
    ];
    const records: AttendanceRecord[] = workedDates.map((date, idx) => ({
      id: `r${idx}`,
      storeId: "s1",
      organizationId: "o1",
      userId: "u1",
      employeeName: "Alice",
      date,
      clockInAt: `${date}T02:00:00Z`,
      clockOutAt: `${date}T10:00:00Z`,
      status: "completed",
      createdAt: "",
      updatedAt: "",
    }));

    const result = lines({
      records,
      profiles: [profile({ payType: "monthly", monthlySalary: 31000, workingDays: [1, 2, 3, 4, 5] })],
      adjustments: [adj({ type: "leave", amount: 0, date: "2026-07-13" })],
      settings: settings({ absentPenaltyPerDay: 999 }),
      holidayDates: ["2026-07-14"],
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      today: "2026-07-15",
    });

    // Only 2026-07-15 is unaccounted for; July 2026 has 23 Mon–Fri days → ฿31,000 ÷ 23.
    expect(result[0].absentDays).toBe(1);
    expect(result[0].absentPenalty).toBe(1347.83);
    expect(result[0].netPay).toBe(29652.17);
  });

  it("counts a clock-in with no clock-out as absence, but leaves today's open shift alone", () => {
    const rec = (id: string, date: string, clockOutAt: string | null): AttendanceRecord => ({
      id, storeId: "s1", organizationId: "o1", userId: "u1", employeeName: "Alice",
      date, clockInAt: `${date}T01:00:00Z`, clockOutAt,
      status: clockOutAt ? "completed" : "active", createdAt: "", updatedAt: "",
    });
    const result = lines({
      records: [
        rec("r1", "2026-01-06", "2026-01-06T10:00:00Z"), // closed properly
        rec("r2", "2026-01-07", null), // forgot to clock out → absence
        rec("r3", "2026-01-08", null), // today, still on shift → not absence
      ],
      profiles: [profile({ payType: "monthly", monthlySalary: 23000, workingDays: [1, 2, 3, 4, 5] })],
      periodStart: "2026-01-06",
      periodEnd: "2026-02-05",
      today: "2026-01-08",
    });
    expect(result[0].absentDays).toBe(1);
    expect(result[0].absentPenalty).toBe(1000);
  });

  it("pro-rates over the pay period, not the calendar month", () => {
    // Staff hired on the 6th → payroll runs 6 ม.ค. – 5 ก.พ., which holds 23 Mon–Fri days.
    // Each missed day costs ฿23,000 ÷ 23, regardless of where the month boundary falls.
    const result = lines({
      profiles: [profile({ payType: "monthly", monthlySalary: 23000, workingDays: [1, 2, 3, 4, 5] })],
      settings: settings({ absentPenaltyPerDay: 0 }),
      periodStart: "2026-01-06",
      periodEnd: "2026-02-05",
      today: "2026-01-08", // Tue 1/6, Wed 1/7, Thu 1/8 all missed
    });
    expect(result[0].absentDays).toBe(3);
    expect(result[0].absentPenalty).toBe(3000);
    expect(result[0].netPay).toBe(20000);
  });

  it("pro-rates a monthly salary even when the store sets no flat absent rate", () => {
    const result = lines({
      profiles: [profile({ payType: "monthly", monthlySalary: 23000, workingDays: [1, 2, 3, 4, 5] })],
      settings: settings({ absentPenaltyPerDay: 0 }),
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      today: "2026-07-02", // Wed 7/1 + Thu 7/2, no records at all
    });
    expect(result[0].absentDays).toBe(2);
    expect(result[0].absentPenalty).toBe(2000); // 23000 ÷ 23 × 2
    expect(result[0].netPay).toBe(21000);
  });

  it("never charges a holiday or a scheduled day off as absence", () => {
    const result = lines({
      profiles: [profile({ payType: "monthly", monthlySalary: 23000, workingDays: [1, 2, 3, 4, 5] })],
      holidayDates: ["2026-07-01", "2026-07-02", "2026-07-03"],
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      today: "2026-07-05", // 7/1–7/3 declared holidays, 7/4–7/5 Sat–Sun off the schedule
    });
    expect(result[0].absentDays).toBe(0);
    expect(result[0].absentPenalty).toBe(0);
    expect(result[0].netPay).toBe(23000);
  });

  it("prefers the employee's own absent rate over the pro-rated salary", () => {
    const result = lines({
      profiles: [
        profile({ payType: "monthly", monthlySalary: 23000, absentPenaltyAmount: 400, workingDays: [1, 2, 3, 4, 5] }),
      ],
      settings: settings({ absentPenaltyPerDay: 999 }),
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      today: "2026-07-02",
    });
    expect(result[0].absentPenalty).toBe(800);
  });

  it("judges lateness by the first punch of the day, whatever order records arrive in", () => {
    const rec = (id: string, clockInAt: string, clockOutAt: string): AttendanceRecord => ({
      id, storeId: "s1", organizationId: "o1", userId: "u1", employeeName: "Alice",
      date: "2026-06-02", clockInAt, clockOutAt, status: "completed", createdAt: "", updatedAt: "",
    });
    // Split shift in Asia/Bangkok: in 08:00, out 12:00, back 13:00, out 17:00 — on time.
    // Records come back newest-first, exactly as the repository orders them.
    const result = lines({
      records: [
        rec("r2", "2026-06-02T06:00:00Z", "2026-06-02T10:00:00Z"),
        rec("r1", "2026-06-02T01:00:00Z", "2026-06-02T05:00:00Z"),
      ],
      profiles: [profile({ payType: "daily", expectedStartTime: "08:00", lateGraceMinutes: 5 })],
      settings: settings({ latePenaltyPerMinute: 2 }),
      periodStart: "2026-06-02",
      periodEnd: "2026-06-02",
      today: "2026-06-02",
    });
    expect(result[0].latePenalty).toBe(0);
  });

  it("charges a late day once, capped by the store maximum", () => {
    const rec: AttendanceRecord = {
      id: "r1", storeId: "s1", organizationId: "o1", userId: "u1", employeeName: "Alice",
      date: "2026-06-02", clockInAt: "2026-06-02T02:00:00Z", clockOutAt: "2026-06-02T10:00:00Z",
      status: "completed", createdAt: "", updatedAt: "",
    };
    // 09:00 local vs 08:00 expected = 60 min late × ฿2 = ฿120, capped at ฿100.
    const result = lines({
      records: [rec],
      profiles: [profile({ payType: "daily", expectedStartTime: "08:00" })],
      settings: settings({ latePenaltyPerMinute: 2, latePenaltyMaxPerDay: 100 }),
      periodStart: "2026-06-02",
      periodEnd: "2026-06-02",
      today: "2026-06-02",
    });
    expect(result[0].latePenalty).toBe(100);
  });

  it("prefers the employee's flat late fine over the per-minute rate", () => {
    const rec: AttendanceRecord = {
      id: "r1", storeId: "s1", organizationId: "o1", userId: "u1", employeeName: "Alice",
      date: "2026-06-02", clockInAt: "2026-06-02T02:00:00Z", clockOutAt: "2026-06-02T10:00:00Z",
      status: "completed", createdAt: "", updatedAt: "",
    };
    const result = lines({
      records: [rec],
      profiles: [profile({ payType: "daily", expectedStartTime: "08:00", latePenaltyAmount: 50 })],
      settings: settings({ latePenaltyPerMinute: 0 }),
      periodStart: "2026-06-02",
      periodEnd: "2026-06-02",
      today: "2026-06-02",
    });
    expect(result[0].latePenalty).toBe(50);
  });
});

describe("HR payroll migration + repository wiring", () => {
  const migration = read("supabase/migrations/20260607000003_hr_payroll.sql");

  it("defines employee_profiles + payroll_adjustments with manager RLS", () => {
    expect(migration).toContain("create table if not exists employee_profiles");
    expect(migration).toContain("pay_type in ('monthly','daily','hourly')");
    expect(migration).toContain("unique (store_id, user_id)");
    expect(migration).toContain("create table if not exists payroll_adjustments");
    expect(migration).toContain("type in ('penalty','bonus','leave','absent','late')");
    expect(migration).toContain("employee_profiles: manager+ can write");
    expect(migration).toContain("payroll_adjustments: manager+ can write");
    expect(migration).toContain("attendance: manager+ can delete");
  });

  it("defines store_hr_settings + working_days/ot_eligible (batch migration)", () => {
    const m = read("supabase/migrations/20260607000004_hr_settings.sql");
    expect(m).toContain("create table if not exists store_hr_settings");
    expect(m).toContain("ot_multiplier");
    expect(m).toContain("ot_daily_cap_hours");
    expect(m).toContain("late_penalty_per_minute");
    expect(m).toContain("absent_penalty_per_day");
    expect(m).toContain("backdated_rights_per_month");
    expect(m).toContain("store_hr_settings: manager+ can write");
    expect(m).toContain("add column if not exists working_days");
    expect(m).toContain("add column if not exists ot_eligible");
  });

  it("staff/attendance actions enforce permissions", () => {
    const staffActions = read("src/app/(dashboard)/staff/actions.ts");
    expect(staffActions).toContain('requirePermission("users.manage")');
    expect(staffActions).toContain('requirePermission("attendance.manage")');
    expect(staffActions).toContain("saveHrSettingsAction");
    const attActions = read("src/app/(dashboard)/attendance/actions.ts");
    expect(attActions).toContain("addManualAttendanceAction");
    expect(attActions).toContain("adjustAttendanceAction");
    expect(attActions).toContain("deleteAttendanceAction");
  });

  it("self backdated clock enforces monthly rights + past-date only", () => {
    const att = read("src/app/(dashboard)/attendance/actions.ts");
    expect(att).toContain("selfBackdatedClockAction");
    expect(att).toContain("countSelfBackdated");
    expect(att).toContain("backdatedRightsPerMonth");
    expect(att).toContain("date >= today"); // past-date guard
    const repo = read("src/modules/attendance/repository.ts");
    expect(repo).toContain("countSelfBackdated");
    expect(repo).toContain('.eq("adjusted_by_user_id", userId)');
    expect(repo).toContain('.eq("status", "backdated")');
  });

  it("payslip route + PDF export links exist", () => {
    const payslip = read("src/app/payslip/page.tsx");
    expect(payslip).toContain("getResolvedCurrentPermissions");
    expect(payslip).toContain("computePayrollLines");
    expect(payslip).toContain('params.mode === "summary"');
    const staff = read("src/app/(dashboard)/staff/StaffManager.tsx");
    expect(staff).toContain("/payslip?mode=summary");
    expect(staff).toContain("/payslip?userId=");
  });

  it("staff and payslip payroll calculations pass store holidays", () => {
    const staffPage = read("src/app/(dashboard)/staff/page.tsx");
    const payslipPage = read("src/app/payslip/page.tsx");

    for (const source of [staffPage, payslipPage]) {
      expect(source).toContain("listStoreHolidays(ctx.storeId, dateFrom, dateTo)");
      expect(source).toContain("holidayDates: (holidaysRes.data ?? []).map((h) => h.date)");
    }
  });

  it("matches attendance by employee, not by the branch they punched at", () => {
    const staffPage = read("src/app/(dashboard)/staff/page.tsx");
    const payslipPage = read("src/app/payslip/page.tsx");

    for (const source of [staffPage, payslipPage]) {
      // null store id = read every branch (RLS still scopes it), then keep this store's roster.
      expect(source).toContain("listAttendanceRecords(ctx.organizationId, null, dateFrom, dateTo)");
      expect(source).toContain("listStoreMemberships(ctx.organizationId, ctx.storeId)");
      expect(source).toContain("roster.has(r.userId)");
      // Wages, adjustments and holidays stay on the store the manager is signed into.
      expect(source).toContain("listEmployeeProfiles(ctx.storeId)");
      expect(source).toContain("listPayrollAdjustments(ctx.storeId, dateFrom, dateTo)");
    }
  });
});
