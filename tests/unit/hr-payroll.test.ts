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
      profiles: [profile({ payType: "monthly", monthlySalary: 10000 })],
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
});
