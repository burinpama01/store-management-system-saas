/**
 * วันให้ OT: โบนัสยอดขายรายวัน — คนที่ออกก่อนจบช่วง OT ได้ตามยอดตอนที่ตัวเองออกงาน
 * "อยู่จนจบ OT" = อยู่ในรายชื่อ OT ของวันนั้น และได้ OT จริง (≥ 1 ชม.เต็ม)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeDailySalesBonuses,
  computeStoreSalesDays,
  layeredShare,
  salesDayBonusFor,
} from "@/modules/hr/advanced/income";
import { DEFAULT_ADVANCED_PAYROLL_SETTINGS, normalizeSwitches } from "@/modules/hr/advanced/settings";
import { computeAdvancedPayrollLines, type AdvancedComputeContext } from "@/modules/hr/advanced/compute";
import { otDayClockOutCutoffs } from "@/modules/hr/advanced/store-payroll";
import { DEFAULT_HR_SETTINGS, type EmployeeProfile, type StoreHrSettings } from "@/modules/hr/types";
import type { PayrollDay } from "@/modules/hr/payroll";
import type { AttendanceRecord, PayrollSummary } from "@/modules/attendance/types";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const tiers = DEFAULT_ADVANCED_PAYROLL_SETTINGS.salesBonusTiers; // 30k→100 · 35k→150 · 40k→250
const cfg = { tiers, recordBonus: 0, recordMode: "replace" as const };
const D = "2026-11-20";

function day(hours = 8): PayrollDay {
  return { date: D, hours, clockInAt: null, clockOutAt: null, status: "full", late: false, lateMinutes: 0 };
}

const storeDays = computeStoreSalesDays({
  dailySales: new Map([[D, 42000]]),
  dates: [D],
  tiers,
  recordBaseline: 0,
  maxBeforePeriod: 999999,
  recordBonus: 0,
  recordMode: "replace",
});

describe("layeredShare — หารเป็นชั้น", () => {
  it("ทุกคนระดับเท่ากัน = ก้อนรวม ÷ จำนวนคน (เหมือนเดิม)", () => {
    expect(layeredShare(250, [250, 250])).toBe(125);
  });
  it("ขั้นที่เพิ่มช่วง OT หารเฉพาะคนที่ยังอยู่", () => {
    // ก: ออกตอนยอดถึงขั้น 100 · ข, ค: อยู่จนจบ (250)
    // ชั้น 0→100 หาร 3 = 33.33 · ชั้น 100→250 หาร 2 = 75
    expect(layeredShare(100, [100, 250, 250])).toBeCloseTo(33.333, 2);
    expect(layeredShare(250, [100, 250, 250])).toBeCloseTo(108.333, 2);
  });
  it("ออกก่อนยอดถึงขั้นแรก = 0", () => {
    expect(layeredShare(0, [0, 250])).toBe(0);
    expect(layeredShare(250, [0, 250])).toBe(250);
  });
});

describe("computeDailySalesBonuses — ตัดยอดตามเวลาออกงาน", () => {
  const employees = [
    { userId: "early", days: [day()] },
    { userId: "stay", days: [day(11)] },
  ];
  const cutoff = (userId: string) => (userId === "early" ? 31000 : null);
  const personal = (sales: number, store: (typeof storeDays extends Map<string, infer V> ? V : never)) =>
    salesDayBonusFor(sales, store.recordBefore ?? Infinity, cfg);

  it("per_person: ออกก่อน = ขั้นตอนออก (100) · อยู่จนจบ = ขั้นทั้งวัน (250)", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: null, mode: "per_person", cutoffSalesFor: cutoff, personalBonusFor: personal });
    expect(r.get("early")!.total).toBe(100);
    expect(r.get("early")!.days[0]).toMatchObject({ amount: 100, cutoffSales: 31000 });
    expect(r.get("stay")!.total).toBe(250);
    expect(r.get("stay")!.days[0].cutoffSales).toBeUndefined();
  });

  it("per_person: ออกก่อนยอดถึงขั้นแรก = ไม่ได้โบนัสวันนั้น", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: null, mode: "per_person", cutoffSalesFor: (u) => (u === "early" ? 12000 : null), personalBonusFor: personal });
    expect(r.get("early")!.total).toBe(0);
    expect(r.get("early")!.days).toHaveLength(0);
  });

  it("split: หารเป็นชั้น — คนที่อยู่จนจบได้ส่วนเพิ่มช่วง OT ไปเต็ม", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: null, mode: "split", cutoffSalesFor: cutoff, personalBonusFor: personal });
    // ชั้น 0→100 หาร 2 = 50 · ชั้น 100→250 ได้คนเดียว 150
    expect(r.get("early")!.total).toBe(50);
    expect(r.get("stay")!.total).toBe(200);
  });

  it("ยอดตอนออก ≥ ยอดทั้งวัน (ออกพร้อมปิด) = ได้ตามยอดทั้งวัน ไม่ติดป้ายตัดยอด", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: null, mode: "per_person", cutoffSalesFor: () => 42000, personalBonusFor: personal });
    expect(r.get("early")!.days[0]).toMatchObject({ amount: 250 });
    expect(r.get("early")!.days[0].cutoffSales).toBeUndefined();
  });

  it("ไม่ส่งตัวตัดยอด = แบบเดิมทุกบาท", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: null, mode: "split" });
    expect(r.get("early")!.total).toBe(125);
    expect(r.get("stay")!.total).toBe(125);
  });

  it("หารเป็นชั้นติดป้าย layered · วันปกติไม่ติด", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: null, mode: "split", cutoffSalesFor: cutoff, personalBonusFor: personal });
    expect(r.get("stay")!.days[0].layered).toBe(true);
    const plain = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: null, mode: "split" });
    expect(plain.get("stay")!.days[0].layered).toBeUndefined();
  });

  it("ตัดยอด + สถิติ (แทนที่): ยอดตอนออกทำสถิติ → ได้โบนัสสถิติ", () => {
    const rec = computeStoreSalesDays({ dailySales: new Map([[D, 42000]]), dates: [D], tiers, recordBaseline: 0, maxBeforePeriod: 30000, recordBonus: 500, recordMode: "replace" });
    const recCfg = { tiers, recordBonus: 500, recordMode: "replace" as const };
    const r = computeDailySalesBonuses({
      employees,
      storeDays: rec,
      isEligibleOn: () => true,
      lateMaxMinutes: null,
      mode: "per_person",
      cutoffSalesFor: (u) => (u === "early" ? 31000 : null),
      personalBonusFor: (sales, store) => salesDayBonusFor(sales, store.recordBefore ?? Infinity, recCfg),
    });
    expect(r.get("early")!.days[0]).toMatchObject({ amount: 500, record: true, cutoffSales: 31000 });
    expect(r.get("stay")!.days[0]).toMatchObject({ amount: 500, record: true });
    // ยอดตอนออกยังไม่ทำสถิติ → ขั้นปกติ
    const r2 = computeDailySalesBonuses({ employees, storeDays: rec, isEligibleOn: () => true, lateMaxMinutes: null, mode: "per_person", cutoffSalesFor: (u) => (u === "early" ? 29000 : null), personalBonusFor: (s, st) => salesDayBonusFor(s, st.recordBefore ?? Infinity, recCfg) });
    expect(r2.get("early")!.total).toBe(0);
  });

  it("สถิติยอดขาย: คิดจากยอดตอนออกเทียบสถิติก่อนวันนั้น", () => {
    expect(salesDayBonusFor(31000, 30000, { tiers, recordBonus: 500, recordMode: "replace" })).toMatchObject({ isRecord: true, bonusPerPerson: 500 });
    expect(salesDayBonusFor(29000, 30000, { tiers, recordBonus: 500, recordMode: "replace" })).toMatchObject({ isRecord: false, bonusPerPerson: 0 });
  });
});

describe("otDayClockOutCutoffs — จุดตัด = เวลาออกงานล่าสุดของวันนั้น", () => {
  it("หลายกะ = เอาเวลาออกล่าสุด · ยังมีกะค้าง = ไม่ตัด · วันที่ไม่ใช่วัน OT = ข้าม", () => {
    const out = otDayClockOutCutoffs([D], [
      { userId: "a", date: D, clockOutAt: "2026-11-20T08:00:00.000Z" },
      { userId: "a", date: D, clockOutAt: "2026-11-20T13:00:00.000Z" },
      { userId: "b", date: D, clockOutAt: "2026-11-20T10:00:00.000Z" },
      { userId: "b", date: D, clockOutAt: null },
      { userId: "c", date: "2026-11-19", clockOutAt: "2026-11-19T13:00:00.000Z" },
    ]);
    expect(out).toEqual([{ key: `${D}|a`, date: D, until: "2026-11-20T13:00:00.000Z" }]);
  });
});

// ---------------------------------------------------------------------------
// ทั้งงวด: ใครนับว่า "อยู่จนจบ OT"
// ---------------------------------------------------------------------------
const hr = (over: Partial<StoreHrSettings> = {}): StoreHrSettings => ({
  ...DEFAULT_HR_SETTINGS,
  storeId: "s1",
  organizationId: "o1",
  createdAt: "",
  updatedAt: "",
  ...over,
});
const prof = (userId: string): EmployeeProfile =>
  ({
    id: `p-${userId}`,
    organizationId: "o1",
    storeId: "s1",
    userId,
    payType: "daily",
    monthlySalary: 0,
    dailyRate: 400,
    hourlyRate: 0,
    lateGraceMinutes: 0,
    latePenaltyAmount: 0,
    workingDays: [],
    otEligible: false,
    employmentType: "permanent",
    permanentSince: "2025-01-01",
    seniorityStartDate: "2025-01-01",
    createdAt: "",
    updatedAt: "",
  }) as unknown as EmployeeProfile;
function rec(userId: string, hours: number): AttendanceRecord {
  const inAt = `${D}T02:00:00.000Z`;
  return {
    id: `${userId}-${D}`,
    organizationId: "o1",
    storeId: "s1",
    userId,
    employeeName: userId,
    date: D,
    clockInAt: inAt,
    clockOutAt: new Date(Date.parse(inAt) + hours * 3_600_000).toISOString(),
    status: "completed",
  } as AttendanceRecord;
}
const summary = (userId: string, hours: number) =>
  ({ userId, employeeName: userId, totalDays: 1, totalHours: hours, regularHours: 0, overtimeHours: 0 }) as PayrollSummary;

describe("ทั้งงวด (computeAdvancedPayrollLines)", () => {
  // early ออกหลังทำ 8 ชม. (ไม่อยู่ในรายชื่อ OT) · listedNoOt อยู่ในรายชื่อแต่ทำ OT ไม่ถึง 1 ชม. · stay ทำ OT 3 ชม.
  const records = [rec("early", 8), rec("listedNoOt", 8.5), rec("stay", 11)];
  const ctx: AdvancedComputeContext = {
    settings: { ...DEFAULT_ADVANCED_PAYROLL_SETTINGS, switches: normalizeSwitches({ salesBonus: true }) },
    employees: new Map(),
    dailySales: new Map([[D, 42000]]),
    maxSalesBeforePeriod: 999999,
    salesAtClockOut: new Map([
      [`${D}|early`, 31000],
      [`${D}|listedNoOt`, 36000],
      [`${D}|stay`, 42000],
    ]),
  };
  const run = (otMode: "scheduled" | "daily", c: AdvancedComputeContext = ctx) =>
    new Map(
      computeAdvancedPayrollLines(
        {
          summaries: [summary("early", 8), summary("listedNoOt", 8.5), summary("stay", 11)],
          records,
          profiles: [prof("early"), prof("listedNoOt"), prof("stay")],
          adjustments: [],
          settings: hr({ otMode, regularHoursPerDay: 8 }),
          otDays: [{ id: "x", storeId: "s1", organizationId: "o1", date: D, capHours: 4, multiplier: null, userIds: ["listedNoOt", "stay"], note: null, createdAt: "", updatedAt: "" } as never],
          periodStart: "2026-11-16",
          periodEnd: "2026-11-30",
          today: "2026-12-01",
          timezone: "Asia/Bangkok",
        },
        c,
      ).map((l) => [l.userId, l.salesBonus]),
    );

  it("ออกก่อน → ขั้นตอนออก · ในรายชื่อแต่ไม่ได้ OT จริง → นับว่าออกก่อน · ทำ OT จริง → ยอดทั้งวัน", () => {
    const r = run("scheduled");
    expect(r.get("early")).toBe(100);
    expect(r.get("listedNoOt")).toBe(150);
    expect(r.get("stay")).toBe(250);
  });

  it("โหมด OT ทุกวัน = ไม่ตัดยอด (แบบเดิม)", () => {
    const r = run("daily");
    expect([r.get("early"), r.get("listedNoOt"), r.get("stay")]).toEqual([250, 250, 250]);
  });

  it("โหลดยอดตอนออกไม่ได้ (ไม่มี salesAtClockOut) = ไม่ตัดยอด", () => {
    const r = run("scheduled", { ...ctx, salesAtClockOut: undefined });
    expect([r.get("early"), r.get("listedNoOt"), r.get("stay")]).toEqual([250, 250, 250]);
  });
});

describe("ต่อสาย (source)", () => {
  it("ทุกจุดที่โหลด context ส่งวันให้ OT + เวลาเข้าออกงาน", () => {
    for (const f of ["src/app/(dashboard)/staff/page.tsx", "src/app/payslip/page.tsx", "src/modules/hr/advanced/store-payroll.ts"]) {
      expect(read(f)).toMatch(/loadAdvancedContext\([^)]*\{ otDays, records \}\)/);
    }
  });
  it("migration: นับยอดตามวันทำการแบบเดียวกับยอดรายวัน + สิทธิ์เฉพาะ service_role", () => {
    const sql = read("supabase/migrations/20261208120000_payroll_sales_until.sql");
    expect(sql).toContain("public.payroll_business_day_offset(s.id)");
    expect(sql).toContain("and o.paid_at <= c.t");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
  it("RPC ได้แถวไม่ครบจุดตัด = โยน error (ไม่ได้ 0 เงียบ ๆ)", () => {
    expect(read("src/modules/hr/advanced/repository.ts")).toContain("data.length !== cutoffs.length");
  });
  it("โหลดยอดตอนออกไม่ได้ = log + ไม่ตัด (หน้าเงินเดือนไม่ล้ม)", () => {
    const src = read("src/modules/hr/advanced/store-payroll.ts");
    expect(src).toContain('action: "loadOtDaySalesAtClockOut"');
    expect(src).toContain("return undefined;");
  });
  it("สลิปบอกว่าโบนัสวันนั้นคิดจากยอดตอนออก", () => {
    expect(read("src/app/payslip/PayslipCard.tsx")).toContain("ออกก่อนจบ OT · ยอดตอนออก");
  });
});
