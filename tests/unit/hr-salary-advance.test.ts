import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocateAdvanceDeduction, computeAdvanceCap } from "@/modules/hr/advanced/salary-advance";
import { advanceOutstanding } from "@/modules/hr/advanced/salary-advance-service";
import { computeAdvancedPayrollLines, type AdvancedComputeContext } from "@/modules/hr/advanced/compute";
import { computeWeeklyPayouts, weekContaining } from "@/modules/hr/advanced/weekly";
import { DEFAULT_ADVANCED_PAYROLL_SETTINGS, normalizeSwitches, type AdvancedPayrollSettings } from "@/modules/hr/advanced/settings";
import { mapAdvancedSettings } from "@/modules/hr/advanced/repository";
import { DEFAULT_HR_SETTINGS, type EmployeeProfile, type StoreHrSettings } from "@/modules/hr/types";
import type { AttendanceRecord, PayrollSummary } from "@/modules/attendance/types";

const TZ = "Asia/Bangkok";
const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

const hr = (over: Partial<StoreHrSettings> = {}): StoreHrSettings => ({
  ...DEFAULT_HR_SETTINGS,
  storeId: "s1",
  organizationId: "o1",
  createdAt: "",
  updatedAt: "",
  ...over,
});
const prof = (over: Partial<EmployeeProfile> = {}): EmployeeProfile => ({
  id: "p1",
  organizationId: "o1",
  storeId: "s1",
  userId: "u1",
  payType: "daily",
  monthlySalary: 0,
  dailyRate: 500,
  hourlyRate: 0,
  lateGraceMinutes: 0,
  latePenaltyAmount: 0,
  absentPenaltyAmount: 0,
  workingDays: [],
  otEligible: false,
  employmentType: "permanent",
  permanentSince: "2025-01-01",
  seniorityStartDate: "2025-01-01",
  createdAt: "",
  updatedAt: "",
  ...over,
});
function rec(date: string, hours: number, userId = "u1"): AttendanceRecord {
  const inAt = `${date}T02:00:00.000Z`;
  return { id: `${userId}-${date}`, organizationId: "o1", storeId: "s1", userId, employeeName: "Alice", date, clockInAt: inAt, clockOutAt: new Date(Date.parse(inAt) + hours * 3_600_000).toISOString() } as AttendanceRecord;
}
function summaryFor(records: AttendanceRecord[], userId = "u1"): PayrollSummary {
  const mine = records.filter((r) => r.userId === userId);
  return { userId, employeeName: "Alice", totalDays: new Set(mine.map((r) => r.date)).size, totalHours: mine.reduce((s, r) => s + (Date.parse(r.clockOutAt!) - Date.parse(r.clockInAt)) / 3_600_000, 0), regularHours: 0, overtimeHours: 0 } as PayrollSummary;
}
const settingsWith = (sw: Partial<AdvancedPayrollSettings["switches"]>): AdvancedPayrollSettings => ({ ...DEFAULT_ADVANCED_PAYROLL_SETTINGS, switches: normalizeSwitches(sw) });

describe("เพดานเบิกเงิน: ไม่เกินค่าแรงจากวันที่มาแล้ว", () => {
  const base = { earned: 3000, maxPercent: 100, maxAmount: null, maxRequests: null, weeklyPaidInCycle: 0, outstanding: 0, usedInCycle: 0, countInCycle: 0 };

  it("เบิกได้ถึงค่าแรงที่ทำได้ · หักยอดค้าง/รออนุมัติ", () => {
    expect(computeAdvanceCap(base)).toMatchObject({ available: 3000, blockedReason: null });
    expect(computeAdvanceCap({ ...base, outstanding: 1000 }).available).toBe(2000);
  });

  it("% ของค่าแรง · ยอดสูงสุดต่อรอบ · ยอดรายสัปดาห์ที่จ่ายไปแล้ว", () => {
    expect(computeAdvanceCap({ ...base, maxPercent: 50 }).available).toBe(1500);
    expect(computeAdvanceCap({ ...base, maxAmount: 2000, usedInCycle: 1500, outstanding: 1500 }).available).toBe(500);
    expect(computeAdvanceCap({ ...base, weeklyPaidInCycle: 2500 }).available).toBe(500);
  });

  it("เบิกครบครั้ง/ยังไม่มีวันทำงาน/ครบค่าแรง = เบิกไม่ได้พร้อมเหตุผล", () => {
    expect(computeAdvanceCap({ ...base, maxRequests: 2, countInCycle: 2 })).toMatchObject({ available: 0, blockedReason: "เบิกครบ 2 ครั้งในรอบนี้แล้ว" });
    expect(computeAdvanceCap({ ...base, earned: 0 }).blockedReason).toBe("ยังไม่มีวันทำงานในรอบนี้");
    expect(computeAdvanceCap({ ...base, outstanding: 3500 })).toMatchObject({ available: 0, blockedReason: "เบิกครบตามค่าแรงที่ทำได้แล้ว" });
  });

  it("ตรวจซ้ำหลังบันทึก: รวมเกินเพดาน/เกินจำนวนครั้ง = overLimit (เท่าเพดานพอดีไม่เกิน)", () => {
    expect(computeAdvanceCap({ ...base, outstanding: 3000 }).overLimit).toBe(false);
    expect(computeAdvanceCap({ ...base, outstanding: 3000.5 }).overLimit).toBe(true);
    expect(computeAdvanceCap({ ...base, maxRequests: 2, countInCycle: 2 }).overLimit).toBe(false);
    expect(computeAdvanceCap({ ...base, maxRequests: 2, countInCycle: 3 }).overLimit).toBe(true);
    expect(computeAdvanceCap({ ...base, maxAmount: 1000, usedInCycle: 1200, outstanding: 1200 }).overLimit).toBe(true);
  });

  it("ยอดค้างของคำขอ: รออนุมัติ = ยอดขอ · จ่ายแล้ว = อนุมัติ − ที่หักแล้ว · ปิด = 0", () => {
    expect(advanceOutstanding({ status: "pending", requestedAmount: 800, approvedAmount: null, deducted: 0 })).toBe(800);
    expect(advanceOutstanding({ status: "paid", requestedAmount: 800, approvedAmount: 700, deducted: 200 })).toBe(500);
    expect(advanceOutstanding({ status: "rejected", requestedAmount: 800, approvedAmount: null, deducted: 0 })).toBe(0);
  });
});

describe("หักเบิกเงิน: เก่าก่อน ไม่เกินยอดสุทธิ ยกยอดส่วนที่เหลือ", () => {
  const dues = [
    { id: "b", paidDate: "2026-11-10", outstanding: 1000 },
    { id: "a", paidDate: "2026-11-03", outstanding: 500 },
    { id: "c", paidDate: "2026-12-02", outstanding: 300 },
  ];
  it("เฉพาะที่จ่ายถึงวันจบงวด · เรียงวันที่จ่าย", () => {
    expect(allocateAdvanceDeduction(dues, "2026-11-30", 99999)).toEqual({
      total: 1500,
      items: [
        { id: "a", paidDate: "2026-11-03", amount: 500 },
        { id: "b", paidDate: "2026-11-10", amount: 1000 },
      ],
      shortfall: 0,
    });
  });
  it("ยอดสุทธิไม่พอ = หักเท่าที่มี ส่วนที่เหลือยกไป", () => {
    const r = allocateAdvanceDeduction(dues, "2026-11-30", 900);
    expect(r).toMatchObject({ total: 900, shortfall: 600 });
    expect(r.items).toEqual([
      { id: "a", paidDate: "2026-11-03", amount: 500 },
      { id: "b", paidDate: "2026-11-10", amount: 400 },
    ]);
    expect(allocateAdvanceDeduction(dues, "2026-11-30", -50)).toMatchObject({ total: 0, items: [], shortfall: 1500 });
  });
});

describe("หักเบิกเงินในงวดเงินเดือนและรายสัปดาห์", () => {
  const NOV = { periodStart: "2026-11-01", periodEnd: "2026-11-30", today: "2026-12-05", timezone: TZ };
  const records = ["2026-11-02", "2026-11-03", "2026-11-04"].map((d) => rec(d, 8));
  const input = (profiles: EmployeeProfile[]) => ({ summaries: [summaryFor(records)], records, profiles, adjustments: [], settings: hr(), ...NOV });
  const ctx = (over: Partial<AdvancedComputeContext> = {}): AdvancedComputeContext => ({
    settings: settingsWith({ salaryAdvance: true, weeklyPay: true }),
    employees: new Map(),
    dailySales: new Map(),
    maxSalesBeforePeriod: 0,
    ...over,
  });

  it("งวดเดือน: หักเบิกจากยอดสุทธิ + รวมในรายการหัก", () => {
    const [plain] = computeAdvancedPayrollLines(input([prof()]), ctx());
    const [l] = computeAdvancedPayrollLines(input([prof()]), ctx({ salaryAdvances: new Map([["u1", [{ id: "a", paidDate: "2026-11-05", outstanding: 600 }]]]) }));
    expect(plain.netPay).toBe(1500);
    expect(l).toMatchObject({ salaryAdvanceDeduction: 600, netPay: 900, salaryAdvanceShortfall: 0 });
    expect(l.totalDeductions).toBe(plain.totalDeductions + 600);
    expect(l.salaryAdvanceItems).toEqual([{ id: "a", paidDate: "2026-11-05", amount: 600 }]);
  });

  it("งวดเดือน: เงินไม่พอ = สุทธิไม่ติดลบ ยอดค้างแสดงไว้", () => {
    const [l] = computeAdvancedPayrollLines(input([prof()]), ctx({ salaryAdvances: new Map([["u1", [{ id: "a", paidDate: "2026-11-05", outstanding: 2000 }]]]) }));
    expect(l).toMatchObject({ salaryAdvanceDeduction: 1500, netPay: 0, salaryAdvanceShortfall: 500 });
  });

  it("แบบแยกรอบรายสัปดาห์: ไม่หักในงวดเดือน (หักในยอดสัปดาห์แทน)", () => {
    const [l] = computeAdvancedPayrollLines(input([prof({ payFrequency: "weekly" })]), ctx({ salaryAdvances: new Map([["u1", [{ id: "a", paidDate: "2026-11-05", outstanding: 600 }]]]) }));
    expect(l.paidWeekly).toBe(true);
    expect(l.salaryAdvanceDeduction).toBe(0);
  });

  it("ยอดรายสัปดาห์: แยกรอบหักเบิก · จ่ายล่วงหน้าไม่หัก (ไปหักในงวดเดือน)", () => {
    const week = weekContaining("2026-11-04", 1);
    const wk = { ...input([prof({ payFrequency: "weekly" })]), periodStart: week.start, periodEnd: week.end };
    const dues = new Map([["u1", [{ id: "a", paidDate: "2026-11-04", outstanding: 600 }]]]);
    const run = (frequency: "weekly" | "weekly_advance") => {
      const profiles = [prof({ payFrequency: frequency })];
      return computeWeeklyPayouts({
        week,
        lines: computeAdvancedPayrollLines({ ...wk, profiles }, ctx()),
        profiles,
        hrSettings: hr(),
        rateBasis: "profile",
        payCycleStartDay: 1,
        payDay: 0,
        salaryAdvances: dues,
      })[0];
    };
    expect(run("weekly")).toMatchObject({ salaryAdvanceDeduction: 600, amount: 900 });
    expect(run("weekly_advance")).toMatchObject({ salaryAdvanceDeduction: 0, amount: 1500 });
  });
});

describe("ตั้งค่า + migration + เส้นทางระบบ", () => {
  it("ค่าเริ่มต้น: ปิด · 100% · ไม่จำกัดยอด/ครั้ง", () => {
    const d = mapAdvancedSettings({});
    expect(d.switches.salaryAdvance).toBe(false);
    expect(d).toMatchObject({ advanceMaxPercent: 100, advanceMaxAmount: null, advanceMaxRequests: null });
    expect(mapAdvancedSettings({ feat_salary_advance: true, advance_max_percent: 50, advance_max_amount: 3000, advance_max_requests: 2 })).toMatchObject({
      advanceMaxPercent: 50,
      advanceMaxAmount: 3000,
      advanceMaxRequests: 2,
    });
  });

  it("migration: ตารางเบิก/ยอดหัก + RLS อ่านเจ้าตัว/ผู้จัดการ + composite FK", () => {
    const sql = src("supabase/migrations/20261111120000_salary_advances.sql");
    expect(sql).toContain("feat_salary_advance boolean not null default false");
    expect(sql).toContain("create table if not exists salary_advances");
    expect(sql).toContain("primary key (advance_id, cycle_kind, cycle_start)");
    expect(sql).toContain("salary_advances_store_org_fk");
    expect(sql).toContain("user_id = auth.uid() or auth_user_has_permission(organization_id, store_id, 'attendance.manage')");
  });

  it("actions: ตรวจเพดานฝั่ง server · อนุมัติแบบมีเงื่อนไขสถานะ · เงินสดลงบัญชีเงินสด · ปิดงวดบันทึกยอดหัก", () => {
    const request = src("src/app/(dashboard)/my-advance/actions.ts");
    expect(request).toContain("if (amount > av.cap.available)");
    const staff = src("src/app/(dashboard)/staff/advance-actions.ts");
    expect(staff).toContain('updateSalaryAdvanceFrom(ctx.storeId, id, "pending", {');
    expect(staff).toContain("excludeAdvanceId: id");
    const repo = src("src/modules/hr/advanced/repository.ts");
    expect(repo).toContain('if (input.payMethod === "cash")');
    expect(repo).toContain('.from("cash_ledger_entries")');
    expect(src("src/modules/hr/advanced/close-period.ts")).toContain('kind: "monthly"');
    expect(src("src/modules/hr/advanced/weekly-close.ts")).toContain('kind: "weekly"');
    expect(src("src/modules/hr/advanced/store-payroll.ts")).toContain('loadSalaryAdvanceDues(storeId, "monthly", periodStart)');
    // สองคำขอ/อนุมัติพร้อมกัน: ตรวจซ้ำหลังเขียน แล้วยกเลิก/ย้อน
    expect(request).toContain("after.cap.overLimit");
    expect(staff).toContain("after.cap.overLimit");
    // บันทึกรายจ่ายไม่สำเร็จ = ย้อนสถานะ (ไม่ใช่แค่เตือน)
    expect(staff).toContain("await revert();");
    // บันทึกเบิกให้ตัวเองไม่ได้
    expect(staff).toContain("if (userId === user.id)");
    // ปิดงวดแล้วบันทึกยอดหักไม่ได้ = ลองซ้ำ + แจ้งผู้จัดการ + คืน error
    const close = src("src/modules/hr/advanced/close-period.ts");
    expect(close).toContain('kind: "advance_deduction_failed"');
    expect(close).toContain("return { ok: false, error: message");
    expect(src("src/modules/hr/advanced/weekly-close.ts")).toContain("แต่บันทึกยอดหักเบิกเงินไม่สำเร็จ");
  });
});
