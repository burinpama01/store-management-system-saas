import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_PAYROLL_FEATURES_OFF,
  DEFAULT_ADVANCED_PAYROLL_SETTINGS,
  effectiveSwitches,
  normalizeSwitches,
  parseTiers,
  type AdvancedPayrollSettings,
} from "@/modules/hr/advanced/settings";
import {
  businessDate,
  closingOffsetMinutes,
  isPeriodDue,
  payDateFor,
  periodContaining,
  previousPeriod,
  recentPeriods,
} from "@/modules/hr/advanced/pay-cycle";
import {
  activeSkillsOn,
  computeStoreSalesDays,
  employeeSalesBonus,
  fullMonthsBetween,
  isPermanentOn,
  rateSegments,
  seniorityPayFor,
  skillPayFor,
  socialSecurityFor,
  withholdingTaxPercent,
  computeDailySalesBonuses,
  computeMonthlySalesBonuses,
  salesBonusEligible,
} from "@/modules/hr/advanced/income";
import { computeAdvancedPayrollLines, joinedDatesFromMembers, payrollWindowFor, type AdvancedComputeContext } from "@/modules/hr/advanced/compute";
import { mapAdvancedSettings } from "@/modules/hr/advanced/repository";
import {
  computeWeeklyPayouts,
  monthlyDailyRate,
  parsePayFrequency,
  isWeekAutoRecordable,
  previousWeek,
  recentWeeks,
  weekContaining,
  weeklyOwnerMessage,
} from "@/modules/hr/advanced/weekly";
import { computePayrollLines, type PayrollDay } from "@/modules/hr/payroll";
import { DEFAULT_HR_SETTINGS, type EmployeeProfile, type PayrollAdjustment, type StoreHrSettings } from "@/modules/hr/types";
import type { AttendanceRecord, PayrollSummary } from "@/modules/attendance/types";
import { getPlanDefinition, BUSINESS_SELECTABLE_FEATURES } from "@/modules/billing/types";

const TZ = "Asia/Bangkok";

// ---------------------------------------------------------------------------
// R32/R33 สวิตช์ + แพ็ก
// ---------------------------------------------------------------------------
describe("สวิตช์ฟีเจอร์และสิทธิ์แพ็ก (R32, R33)", () => {
  it("ค่าเริ่มต้นปิดทุกตัว", () => {
    expect(Object.values(DEFAULT_ADVANCED_PAYROLL_SETTINGS.switches).every((v) => v === false)).toBe(true);
  });

  it("ตัวแม่ปิด = ตัวลูกปิดตาม (แถบเป้าต้องมีโบนัสยอดขาย, สลิปของฉันต้องมีรอบเงินเดือน)", () => {
    const sw = normalizeSwitches({ salesTargetBar: true, myPayslip: true });
    expect(sw.salesTargetBar).toBe(false);
    expect(sw.myPayslip).toBe(false);
    const on = normalizeSwitches({ salesTargetBar: true, salesBonus: true, myPayslip: true, payCycle: true });
    expect(on.salesTargetBar && on.myPayslip).toBe(true);
  });

  it("แพ็กไม่มีสิทธิ์ = ทำงานเหมือนปิดทุกตัว (แต่ค่าที่ตั้งไว้ไม่ถูกลบ)", () => {
    const stored = { ...ALL_PAYROLL_FEATURES_OFF, salesBonus: true, skillPay: true };
    expect(effectiveSwitches(false, stored)).toEqual(ALL_PAYROLL_FEATURES_OFF);
    expect(effectiveSwitches(true, stored).skillPay).toBe(true);
    expect(stored.skillPay).toBe(true);
  });

  it("advancedPayroll: Enterprise มี, แพ็กอื่นไม่มี, Business ซื้อเพิ่มได้", () => {
    expect(getPlanDefinition("enterprise").advancedPayroll).toBe(true);
    for (const plan of ["free", "starter", "standard", "premium"] as const) {
      expect(getPlanDefinition(plan).advancedPayroll).toBe(false);
    }
    expect(BUSINESS_SELECTABLE_FEATURES).toContain("advancedPayroll");
  });

  it("อ่านขั้นจากข้อความ: เรียงจากน้อยไปมาก ตัดแถวผิด คีย์ซ้ำเก็บตัวหลัง", () => {
    expect(parseTiers("12=600, 6=300, x=1, 6=350, -1=5", "months", { maxKey: 600, maxAmount: 1e6 })).toEqual([
      { months: 6, amount: 350 },
      { months: 12, amount: 600 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// R14–R16 รอบเงินเดือน / วันจ่าย / วันขาย
// ---------------------------------------------------------------------------
describe("รอบเงินเดือนและวันจ่าย (R14–R16, R4)", () => {
  it("เริ่มรอบวันที่ 24 → 24 ต.ค.–23 พ.ย.", () => {
    expect(periodContaining("2026-11-06", 24, 0)).toMatchObject({ start: "2026-10-24", end: "2026-11-23" });
    expect(periodContaining("2026-11-24", 24, 0)).toMatchObject({ start: "2026-11-24", end: "2026-12-23" });
  });

  it("เริ่มวันที่ 1 = เดือนปฏิทิน", () => {
    expect(periodContaining("2026-02-15", 1, 0)).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("วันจ่าย: 0 = วันสุดท้ายของเดือน; 31 ในเดือน 30 วัน = วันที่ 30 (ไม่มี 31 พ.ย.)", () => {
    expect(payDateFor("2026-11-23", 0)).toBe("2026-11-30");
    expect(payDateFor("2026-11-23", 31)).toBe("2026-11-30");
    expect(payDateFor("2027-02-23", 31)).toBe("2027-02-28");
  });

  it("วันจ่ายตกก่อนวันจบงวด → เลื่อนไปเดือนถัดไป", () => {
    expect(payDateFor("2026-11-23", 5)).toBe("2026-12-05");
    expect(payDateFor("2026-12-23", 5)).toBe("2027-01-05");
  });

  it("งวดก่อนหน้า / รายการงวดล่าสุด", () => {
    const cur = periodContaining("2026-11-06", 24, 0);
    expect(previousPeriod(cur, 24, 0)).toMatchObject({ start: "2026-09-24", end: "2026-10-23" });
    expect(recentPeriods("2026-11-06", 24, 0, 3).map((p) => p.start)).toEqual(["2026-10-24", "2026-09-24", "2026-08-24"]);
  });

  it("ปิดงวดหลังเวลาปิดร้านของวันสุดท้าย: ปิด 02:00 → 01:30 ของวันที่ 24 ยังเป็นวันทำการ 23", () => {
    expect(closingOffsetMinutes("02:00:00")).toBe(120);
    expect(closingOffsetMinutes("22:00")).toBe(0);
    expect(closingOffsetMinutes(null)).toBe(0);
    const p = periodContaining("2026-11-20", 24, 0);
    const at0130 = businessDate(new Date("2026-11-23T18:30:00Z"), TZ, "02:00"); // 24 พ.ย. 01:30 ไทย
    const at0230 = businessDate(new Date("2026-11-23T19:30:00Z"), TZ, "02:00"); // 24 พ.ย. 02:30 ไทย
    expect(at0130).toBe("2026-11-23");
    expect(isPeriodDue(p, at0130)).toBe(false);
    expect(at0230).toBe("2026-11-24");
    expect(isPeriodDue(p, at0230)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ②③④ + ประกันสังคม/ภาษี
// ---------------------------------------------------------------------------
const permanent = (over: Partial<EmployeeProfile> = {}) =>
  ({ employmentType: "permanent", permanentSince: "2026-01-01", ...over }) as EmployeeProfile;

describe("ค่าทักษะ / อายุงาน (R8, R9, R10, R26)", () => {
  it("ประจำ ณ วันนั้นเท่านั้น; รายวันไม่ได้; ลาออกแล้วไม่ได้", () => {
    expect(isPermanentOn(permanent(), "2026-02-01")).toBe(true);
    expect(isPermanentOn(permanent({ permanentSince: "2026-03-01" }), "2026-02-01")).toBe(false);
    expect(isPermanentOn(permanent({ employmentType: "daily" }), "2026-02-01")).toBe(false);
    expect(isPermanentOn(permanent({ employmentEndDate: "2026-01-31" }), "2026-02-01")).toBe(false);
  });

  it("ทักษะ ณ วันแรกของงวด: ได้กลางงวดยังไม่นับ, ถอนกลางงวดยังนับ", () => {
    const grants = [
      { skillId: "a", skillName: "เสิร์ฟ", grantedAt: "2026-01-10" },
      { skillId: "b", skillName: "แคชเชียร์", grantedAt: "2026-11-01" },
      { skillId: "c", skillName: "สต็อก", grantedAt: "2026-01-10", revokedAt: "2026-11-01" },
    ];
    expect(activeSkillsOn(grants, "2026-10-24").map((g) => g.skillId)).toEqual(["a", "c"]);
  });

  it("ขั้นค่าทักษะ: 1=500, 2=1000, 3+=1500", () => {
    const tiers = DEFAULT_ADVANCED_PAYROLL_SETTINGS.skillTiers;
    expect([0, 1, 2, 3, 5].map((n) => skillPayFor(n, tiers))).toEqual([0, 500, 1000, 1500, 1500]);
  });

  it("อายุงานนับเดือนเต็ม + ขั้นสูงสุด 1,200", () => {
    expect(fullMonthsBetween("2025-10-24", "2026-10-24")).toBe(12);
    expect(fullMonthsBetween("2025-10-25", "2026-10-24")).toBe(11);
    const tiers = DEFAULT_ADVANCED_PAYROLL_SETTINGS.seniorityTiers;
    expect([5, 6, 12, 30, 60].map((m) => seniorityPayFor(m, tiers))).toEqual([0, 300, 600, 900, 1200]);
  });
});

function day(date: string, status: PayrollDay["status"], lateMinutes = 0): PayrollDay {
  return { date, hours: status === "full" ? 8 : 3, clockInAt: null, clockOutAt: null, status, late: lateMinutes > 0, lateMinutes };
}

describe("โบนัสยอดขายรายวัน (R1–R6)", () => {
  const tiers = DEFAULT_ADVANCED_PAYROLL_SETTINGS.salesBonusTiers;
  const sales = new Map([
    ["2026-11-01", 31000],
    ["2026-11-02", 36000],
    ["2026-11-03", 41000],
    ["2026-11-04", 20000],
    ["2026-11-05", 45000],
  ]);
  const dates = [...sales.keys()];

  it("ขั้นตามยอด + สถิติเทียบยอดสูงสุดก่อนหน้า (แทนขั้นปกติ)", () => {
    const days = computeStoreSalesDays({ dailySales: sales, dates, tiers, recordBaseline: 0, maxBeforePeriod: 42000, recordBonus: 500, recordMode: "replace" });
    expect(days.get("2026-11-01")!.bonusPerPerson).toBe(100);
    expect(days.get("2026-11-02")!.bonusPerPerson).toBe(150);
    expect(days.get("2026-11-03")!.bonusPerPerson).toBe(250);
    expect(days.get("2026-11-04")!.bonusPerPerson).toBe(0);
    expect(days.get("2026-11-05")).toMatchObject({ isRecord: true, bonusPerPerson: 500 });
  });

  it("โหมดบวกเพิ่ม: ขั้นปกติ + สถิติ", () => {
    const days = computeStoreSalesDays({ dailySales: sales, dates, tiers, recordBaseline: 0, maxBeforePeriod: 42000, recordBonus: 500, recordMode: "stack" });
    expect(days.get("2026-11-05")!.bonusPerPerson).toBe(750);
  });

  it("ยอดสถิติเริ่มต้นที่ร้านตั้ง กันช่วงแรกทำสถิติทุกวัน", () => {
    const days = computeStoreSalesDays({ dailySales: sales, dates, tiers, recordBaseline: 50000, maxBeforePeriod: 0, recordBonus: 500, recordMode: "replace" });
    expect([...days.values()].some((d) => d.isRecord)).toBe(false);
  });

  it("เฉพาะวันเต็ม: ครึ่งวัน/ลืมลงออก/ขาด/ลา ไม่ได้; มาสายเกินเกณฑ์ไม่ได้; ทำวันหยุดได้ปกติ", () => {
    const storeDays = computeStoreSalesDays({ dailySales: sales, dates, tiers, recordBaseline: 0, maxBeforePeriod: 99999, recordBonus: 500, recordMode: "replace" });
    const empDays = [
      day("2026-11-01", "full"),
      day("2026-11-02", "half"),
      day("2026-11-03", "in_no_out"),
      day("2026-11-04", "full"),
      day("2026-11-05", "full", 30),
    ];
    const noLateRule = employeeSalesBonus({ days: empDays, storeDays, isEligibleOn: () => true, lateMaxMinutes: null });
    expect(noLateRule.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-05"]);
    expect(noLateRule.total).toBe(100 + 250);
    const lateRule = employeeSalesBonus({ days: empDays, storeDays, isEligibleOn: () => true, lateMaxMinutes: 15 });
    expect(lateRule.total).toBe(100);
  });

  it("ไม่ใช่พนักงานประจำวันนั้น = ไม่ได้ (รายวัน/ชั่วคราวไม่ได้)", () => {
    const storeDays = computeStoreSalesDays({ dailySales: sales, dates, tiers, recordBaseline: 0, maxBeforePeriod: 99999, recordBonus: 0, recordMode: "replace" });
    const r = employeeSalesBonus({ days: [day("2026-11-01", "full")], storeDays, isEligibleOn: () => false, lateMaxMinutes: null });
    expect(r.total).toBe(0);
  });
});

describe("ประกันสังคม / ภาษี (R18, R19, R28)", () => {
  it("ฐานตัดที่ต่ำสุด–สูงสุด ปัดเป็นบาท", () => {
    const cfg = { rate: 5, floor: 1650, ceiling: 17500 };
    expect(socialSecurityFor(15000, cfg)).toEqual({ base: 15000, amount: 750 });
    expect(socialSecurityFor(30000, cfg)).toEqual({ base: 17500, amount: 875 });
    expect(socialSecurityFor(1000, cfg)).toEqual({ base: 1650, amount: 83 });
    expect(socialSecurityFor(0, cfg).amount).toBe(0);
  });

  it("ภาษี % คงที่ต่อคน", () => {
    expect(withholdingTaxPercent(20000, 3)).toBe(600);
    expect(withholdingTaxPercent(20000, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// คำนวณทั้งงวด (computeAdvancedPayrollLines)
// ---------------------------------------------------------------------------
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
  payType: "monthly",
  monthlySalary: 15000,
  dailyRate: 0,
  hourlyRate: 0,
  lateGraceMinutes: 0,
  latePenaltyAmount: 0,
  absentPenaltyAmount: 0,
  workingDays: [],
  otEligible: false,
  employmentType: "permanent",
  permanentSince: "2025-01-01",
  seniorityStartDate: "2025-10-24",
  createdAt: "",
  updatedAt: "",
  ...over,
});

function rec(date: string, hours: number, userId = "u1"): AttendanceRecord {
  const inAt = `${date}T02:00:00.000Z`;
  return {
    id: `${userId}-${date}`,
    organizationId: "o1",
    storeId: "s1",
    userId,
    employeeName: "Alice",
    date,
    clockInAt: inAt,
    clockOutAt: new Date(Date.parse(inAt) + hours * 3_600_000).toISOString(),
  } as AttendanceRecord;
}

function summaryFor(records: AttendanceRecord[], userId = "u1"): PayrollSummary {
  const mine = records.filter((r) => r.userId === userId);
  return {
    userId,
    employeeName: "Alice",
    totalDays: new Set(mine.map((r) => r.date)).size,
    totalHours: mine.reduce((s, r) => s + (Date.parse(r.clockOutAt!) - Date.parse(r.clockInAt)) / 3_600_000, 0),
    regularHours: 0,
    overtimeHours: 0,
  } as PayrollSummary;
}

const PERIOD = { periodStart: "2026-10-24", periodEnd: "2026-11-23", today: "2026-11-30", timezone: TZ };

function settingsWith(sw: Partial<AdvancedPayrollSettings["switches"]>): AdvancedPayrollSettings {
  return { ...DEFAULT_ADVANCED_PAYROLL_SETTINGS, switches: normalizeSwitches(sw) };
}

describe("คำนวณทั้งงวด", () => {
  it("ไม่มี context ขั้นสูง = เท่ากับสูตรเดิมทุกบาท", () => {
    const records = [rec("2026-10-25", 8), rec("2026-10-26", 9)];
    const input = { summaries: [summaryFor(records)], records, profiles: [prof({ workingDays: [1, 2, 3, 4, 5] })], adjustments: [], settings: hr(), ...PERIOD };
    const legacy = computePayrollLines(input);
    const adv = computeAdvancedPayrollLines(input, null);
    expect(adv.map((l) => l.netPay)).toEqual(legacy.map((l) => l.netPay));
    expect(adv[0].skillPay + adv[0].seniorityPay + adv[0].salesBonus + adv[0].socialSecurity).toBe(0);
  });

  it("รวม ②③④ + ประกันสังคม ตามตัวอย่างในแผน", () => {
    const records = [rec("2026-11-01", 8), rec("2026-11-02", 8)];
    const ctx: AdvancedComputeContext = {
      settings: settingsWith({ skillPay: true, seniorityPay: true, salesBonus: true, socialSecurity: true }),
      employees: new Map([
        ["u1", { rates: [], skills: [
          { skillId: "a", skillName: "เสิร์ฟ", grantedAt: "2025-05-01" },
          { skillId: "b", skillName: "แคชเชียร์", grantedAt: "2025-05-01" },
          { skillId: "c", skillName: "รับออเดอร์", grantedAt: "2026-11-01" },
        ] }],
      ]),
      dailySales: new Map([["2026-11-01", 31000], ["2026-11-02", 36000]]),
      maxSalesBeforePeriod: 99999,
    };
    const [line] = computeAdvancedPayrollLines(
      { summaries: [summaryFor(records)], records, profiles: [prof()], adjustments: [], settings: hr(), ...PERIOD },
      ctx,
    );
    expect(line.basePay).toBe(15000);
    expect(line.skillPay).toBe(1000); // 2 ทักษะ ณ วันแรกของงวด
    expect(line.pendingSkillNames).toEqual(["รับออเดอร์"]);
    expect(line.seniorityPay).toBe(600); // ครบ 12 เดือน ณ 24 ต.ค.
    expect(line.salesBonus).toBe(250); // 100 + 150
    expect(line.grossEarnings).toBe(16850);
    expect(line.socialSecurity).toBe(843); // 16,850 × 5% = 842.5 → ปัดเป็น 843 (ยังไม่ถึงฐานสูงสุด)
    expect(line.netPay).toBe(16850 - 843);
  });

  it("ปรับเงินเดือนกลางงวด คิดตามวันจริงในงวด (R29)", () => {
    const ctx: AdvancedComputeContext = {
      settings: settingsWith({}),
      employees: new Map([["u1", { skills: [], rates: [
        { payType: "monthly", monthlySalary: 15000, dailyRate: 0, hourlyRate: 0, effectiveFrom: "2000-01-01" },
        { payType: "monthly", monthlySalary: 18100, dailyRate: 0, hourlyRate: 0, effectiveFrom: "2026-11-03" },
      ] }]]),
      dailySales: new Map(),
      maxSalesBeforePeriod: 0,
    };
    const [line] = computeAdvancedPayrollLines(
      { summaries: [], records: [], profiles: [prof({ monthlySalary: 18100 })], adjustments: [], settings: hr(), ...PERIOD },
      ctx,
    );
    // 24 ต.ค.–2 พ.ย. = 10 วันที่ 15,000 · 3–23 พ.ย. = 21 วันที่ 18,100 · งวด 31 วัน
    expect(line.basePay).toBe(Math.round(((15000 * 10) / 31 + (18100 * 21) / 31) * 100) / 100);
    expect(line.rateSegments).toHaveLength(2);
  });

  it("ขึ้นเงินเดือนมีผลงวดหน้า → งวดนี้ยังใช้เรทเดิม (R13)", () => {
    const ctx: AdvancedComputeContext = {
      settings: settingsWith({}),
      employees: new Map([["u1", { skills: [], rates: [
        { payType: "monthly", monthlySalary: 15000, dailyRate: 0, hourlyRate: 0, effectiveFrom: "2000-01-01" },
        { payType: "monthly", monthlySalary: 20000, dailyRate: 0, hourlyRate: 0, effectiveFrom: "2026-11-24" },
      ] }]]),
      dailySales: new Map(),
      maxSalesBeforePeriod: 0,
    };
    const [line] = computeAdvancedPayrollLines(
      { summaries: [], records: [], profiles: [prof({ monthlySalary: 20000 })], adjustments: [], settings: hr(), ...PERIOD },
      ctx,
    );
    expect(line.basePay).toBe(15000);
  });

  it("ลาออกก่อนงวด = ไม่มีบรรทัด; ลาออกกลางงวด = คิดถึงวันออกงาน ไม่นับขาดหลังวันออก (R27)", () => {
    const before = computeAdvancedPayrollLines(
      { summaries: [], records: [], profiles: [prof({ employmentEndDate: "2026-10-20" })], adjustments: [], settings: hr(), ...PERIOD },
      null,
    );
    expect(before).toHaveLength(0);
    const mid = computeAdvancedPayrollLines(
      { summaries: [], records: [], profiles: [prof({ employmentEndDate: "2026-11-02", workingDays: [0, 1, 2, 3, 4, 5, 6], absentPenaltyAmount: 100 })], adjustments: [], settings: hr(), ...PERIOD },
      null,
    );
    expect(mid).toHaveLength(1);
    expect(mid[0].days.at(-1)?.date).toBe("2026-11-02");
    expect(mid[0].absentDays).toBe(10); // 24 ต.ค.–2 พ.ย.
  });

  it("ภาษีกรอกเองไม่ถูกนับเป็นโบนัส และหักเมื่อเปิดสวิตช์ภาษี", () => {
    const adj: PayrollAdjustment = {
      id: "a1", organizationId: "o1", storeId: "s1", userId: "u1", employeeName: "Alice",
      date: "2026-11-10", type: "withholding_tax", amount: 300, createdByUserId: "m", createdAt: "",
    };
    const base = { summaries: [], records: [], profiles: [prof()], adjustments: [adj], settings: hr(), ...PERIOD };
    const off = computeAdvancedPayrollLines(base, null)[0];
    expect(off.bonusTotal).toBe(0);
    expect(off.withholdingTax).toBe(0);
    const on = computeAdvancedPayrollLines(base, { settings: settingsWith({ withholdingTax: true }), employees: new Map(), dailySales: new Map(), maxSalesBeforePeriod: 0 })[0];
    expect(on.withholdingTax).toBe(300);
    expect(on.netPay).toBe(15000 - 300);
  });

  it("พนักงานรายวันไม่ได้ ②③ แม้ร้านเปิด (R8)", () => {
    const ctx: AdvancedComputeContext = {
      settings: settingsWith({ skillPay: true, seniorityPay: true }),
      employees: new Map([["u1", { rates: [], skills: [{ skillId: "a", skillName: "เสิร์ฟ", grantedAt: "2025-01-01" }] }]]),
      dailySales: new Map(),
      maxSalesBeforePeriod: 0,
    };
    const [line] = computeAdvancedPayrollLines(
      { summaries: [], records: [], profiles: [prof({ employmentType: "daily", permanentSince: undefined, payType: "daily", dailyRate: 400 })], adjustments: [], settings: hr(), ...PERIOD },
      ctx,
    );
    expect(line.skillPay + line.seniorityPay).toBe(0);
  });

  it("ช่วงเรทแบ่งตามวันที่มีผล", () => {
    const fallback = { payType: "monthly" as const, monthlySalary: 1, dailyRate: 0, hourlyRate: 0, effectiveFrom: "0000-01-01" };
    const segs = rateSegments(
      [{ ...fallback, monthlySalary: 2, effectiveFrom: "2026-11-01" }],
      "2026-10-24",
      "2026-11-23",
      fallback,
    );
    expect(segs.map((s) => [s.from, s.to, s.days, s.rate.monthlySalary])).toEqual([
      ["2026-10-24", "2026-10-31", 8, 1],
      ["2026-11-01", "2026-11-23", 23, 2],
    ]);
  });
});

// ---------------------------------------------------------------------------
// migration + ความปลอดภัย
// ---------------------------------------------------------------------------
describe("migration เงินเดือนขั้นสูง", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261107000000_advanced_payroll.sql"), "utf8");

  it("สวิตช์ทุกตัวค่าเริ่มต้นปิด", () => {
    for (const col of ["feat_sales_target_bar", "feat_sales_bonus", "feat_skill_pay", "feat_seniority_pay", "feat_social_security", "feat_withholding_tax", "feat_pay_cycle", "feat_my_payslip", "feat_payroll_notifications"]) {
      expect(sql).toContain(`add column if not exists ${col} boolean not null default false`);
    }
  });

  it("พนักงานอ่านสลิปได้เฉพาะของตัวเอง ฉบับปัจจุบัน ถึงวันจ่าย และยังไม่พ้นวันออกงาน", () => {
    const block = sql.slice(sql.indexOf('create policy "payslips: own visible current read"'));
    expect(block).toContain("user_id = auth.uid()");
    expect(block).toContain("superseded_at is null");
    expect(block).toContain("visible_from <=");
    expect(block).toContain("p.employment_end_date <");
  });

  it("RPC ยอดขายเรียกได้เฉพาะ service role และตัดวันตามเวลาปิดร้าน", () => {
    expect(sql).toContain("revoke all on function public.payroll_store_daily_sales(uuid, date, date, text[]) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.payroll_store_daily_sales(uuid, date, date, text[]) to service_role;");
    expect(sql).toContain("s.closing_time < time '12:00'");
    expect(sql).toContain("when o.order_number like 'JDC-%' then 'delivery'");
  });

  it("pg_cron ยิงเฉพาะเมื่อมีสาขาเปิดใช้ (ไม่มีใครเปิด = ไม่เรียก Vercel)", () => {
    expect(sql).toContain("where feat_pay_cycle or feat_payroll_notifications or feat_sales_bonus");
    expect(sql).toContain("'x-payroll-cron-key'");
  });

  it("route cron เปิด public ใน middleware (auth ด้วยกุญแจ Vault ใน handler)", () => {
    const mw = readFileSync(join(process.cwd(), "src/server/integrations/supabase/middleware.ts"), "utf8");
    expect(mw).toContain('request.nextUrl.pathname === "/api/hr/cron/payroll"');
    const route = readFileSync(join(process.cwd(), "src/app/api/hr/cron/payroll/route.ts"), "utf8");
    expect(route).toContain('db.rpc("verify_payroll_cron_key"');
  });

  it("แถบเป้ายอดขาย: ไม่เปิด = ไม่ยิง query ยอดขาย และไม่มี endpoint ดูย้อนหลัง", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/hr/sales-target/route.ts"), "utf8");
    const gate = route.indexOf("if (!sw.salesTargetBar || !sw.salesBonus)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(route.indexOf("loadDailySales("));
    expect(route).toContain("loadDailySales(ctx.storeId, today, today, channels)");
  });
});

describe("รอบแก้หลังรีวิว", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261107000000_advanced_payroll.sql"), "utf8");
  const cron = readFileSync(join(process.cwd(), "src/modules/hr/advanced/cron.ts"), "utf8");
  const repo = readFileSync(join(process.cwd(), "src/modules/hr/advanced/repository.ts"), "utf8");

  it("ปิดงวดเป็นธุรกรรมเดียว + ล็อกต่อสาขา/งวด (กัน cron/คนกดซ้อน และกันงวดปิดแต่สลิปหาย)", () => {
    const fn = sql.slice(sql.indexOf("create or replace function public.close_payroll_period_snapshot"));
    expect(fn).toContain("pg_advisory_xact_lock(hashtext('payroll_close:'");
    expect(fn).toContain("if v_found and v_existing.status = 'closed' then");
    expect(fn).toContain("update payslips set superseded_at = now()");
    expect(sql).toContain("grant execute on function public.close_payroll_period_snapshot(uuid, uuid, date, date, date, uuid, jsonb) to service_role;");
    expect(repo).toContain('db.rpc("close_payroll_period_snapshot"');
  });

  it("เลขที่สลิปผูกกับพนักงาน ไม่ใช่ลำดับในรอบ", () => {
    expect(sql).toContain("upper(substr(replace(s->>'user_id', '-', ''), 1, 8))");
  });

  it("cron ย้อนปิดได้หลายงวด แต่ไม่ย้อนก่อนวันเปิดรอบเงินเดือน และทำทีละ 5 สาขาพร้อมกัน", () => {
    expect(cron).toContain("for (let n = 0; n < 6; n += 1)");
    expect(cron).toContain("probe.end < settings.payCycleEnabledAt");
    expect(cron).toContain("Promise.allSettled(candidates.slice(i, i + BATCH)");
    expect(sql).toContain("add column if not exists pay_cycle_enabled_at date");
  });

  it("index ยอดขายตาม store + paid_at เฉพาะบิลจ่ายแล้ว", () => {
    expect(sql).toContain("create index if not exists orders_store_paid_at_paid_idx on orders(store_id, paid_at) where status = 'paid';");
  });

  it("ลาออกกลางงวด (รายเดือน): ฐานคิดตามวันถึงวันออก ฐาน 30 วัน", () => {
    const [line] = computeAdvancedPayrollLines(
      { summaries: [], records: [], profiles: [prof({ employmentEndDate: "2026-11-02" })], adjustments: [], settings: hr(), ...PERIOD },
      null,
    );
    expect(line.basePay).toBe(5000); // 15,000 × 10/30 (24 ต.ค.–2 พ.ย.)
  });
});

// ---------------------------------------------------------------------------
// โบนัสหารตามคนเข้างาน + เลือกพนักงาน + โบนัสรายเดือน (2026-11-10)
// ---------------------------------------------------------------------------
describe("โบนัสยอดขาย: แจกรายคน / หารตามคนเข้างาน", () => {
  const tiers = DEFAULT_ADVANCED_PAYROLL_SETTINGS.salesBonusTiers;
  const sales = new Map([["2026-11-01", 31000], ["2026-11-02", 41000]]);
  const storeDays = computeStoreSalesDays({ dailySales: sales, dates: [...sales.keys()], tiers, recordBaseline: 0, maxBeforePeriod: 99999, recordBonus: 0, recordMode: "replace" });
  const employees = [
    { userId: "a", days: [day("2026-11-01", "full"), day("2026-11-02", "full")] },
    { userId: "b", days: [day("2026-11-01", "full"), day("2026-11-02", "half")] },
    { userId: "c", days: [day("2026-11-01", "full", 40), day("2026-11-02", "full")] },
  ];

  it("per_person = เท่ากับแบบเดิม (ทุกคนได้เต็มขั้น)", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: null, mode: "per_person" });
    expect(r.get("a")!.total).toBe(100 + 250);
    expect(r.get("b")!.total).toBe(100);
    expect(r.get("c")!.total).toBe(100 + 250);
  });

  it("split: ก้อนรวมของวันหารเท่ากันตามคนที่ผ่านเกณฑ์วันนั้น (ครึ่งวัน/สายเกินเกณฑ์ไม่นับเป็นตัวหาร)", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: () => true, lateMaxMinutes: 15, mode: "split" });
    // 1 พ.ย. ก้อน 100: a, b ผ่าน (c สาย 40 นาที) → คนละ 50 · 2 พ.ย. ก้อน 250: a, c ผ่าน (b ครึ่งวัน) → คนละ 125
    expect(r.get("a")!.total).toBe(50 + 125);
    expect(r.get("b")!.total).toBe(50);
    expect(r.get("c")!.total).toBe(125);
    expect(r.get("a")!.days[0]).toMatchObject({ pool: 100, people: 2, amount: 50 });
  });

  it("split: เฉพาะพนักงานที่เลือกเป็นตัวหาร · หารไม่ลงตัวปัด 2 ตำแหน่ง", () => {
    const r = computeDailySalesBonuses({ employees, storeDays, isEligibleOn: (id) => id !== "b", lateMaxMinutes: null, mode: "split" });
    expect(r.get("b")!.total).toBe(0);
    expect(r.get("a")!.days[0]).toMatchObject({ people: 2, amount: 50 });
    const three = computeDailySalesBonuses({
      employees: employees.map((e) => ({ ...e, days: [day("2026-11-01", "full")] })),
      storeDays,
      isEligibleOn: () => true,
      lateMaxMinutes: null,
      mode: "split",
    });
    expect(three.get("a")!.total).toBe(33.33);
  });

  it("ผู้มีสิทธิ์: เลือกรายชื่อ = เฉพาะในรายชื่อ (ไม่ต้องเป็นประจำ) · ไม่เลือก = ประจำ (แบบเดิม) · ลาออกแล้วไม่ได้", () => {
    const temp = { employmentType: "temporary" as const, permanentSince: undefined, employmentEndDate: undefined };
    const perm = { employmentType: "permanent" as const, permanentSince: "2025-01-01", employmentEndDate: undefined };
    expect(salesBonusEligible(["u1"], "u1", temp, "2026-11-01")).toBe(true);
    expect(salesBonusEligible(["u1"], "u2", perm, "2026-11-01")).toBe(false);
    expect(salesBonusEligible(null, "u2", perm, "2026-11-01")).toBe(true);
    expect(salesBonusEligible(null, "u1", temp, "2026-11-01")).toBe(false);
    expect(salesBonusEligible(["u1"], "u1", { ...temp, employmentEndDate: "2026-10-31" }, "2026-11-01")).toBe(false);
  });
});

describe("โบนัสยอดขายรายเดือน (ตามรอบเงินเดือน)", () => {
  const tiers = [{ minSales: 900000, amount: 1000 }, { minSales: 1000000, amount: 3000 }];
  const employees = [
    { userId: "a", days: [day("2026-11-01", "full"), day("2026-11-02", "full"), day("2026-11-03", "full")] },
    { userId: "b", days: [day("2026-11-01", "full"), day("2026-11-02", "half")] },
    { userId: "c", days: [day("2026-11-01", "absent")] },
  ];

  it("per_person: ทำเต็มวันอย่างน้อย 1 วันได้เต็มจำนวน · ไม่ได้ทำเต็มวันเลย = 0", () => {
    const r = computeMonthlySalesBonuses({ employees, periodSales: 1_050_000, tiers, isEligibleOn: () => true, mode: "per_person" });
    expect(r.get("a")!.amount).toBe(3000);
    expect(r.get("b")!.amount).toBe(3000);
    expect(r.get("c")!.amount).toBe(0);
  });

  it("split: ก้อนรวมหารตามสัดส่วนวันทำเต็มวัน", () => {
    const r = computeMonthlySalesBonuses({ employees, periodSales: 950_000, tiers, isEligibleOn: () => true, mode: "split" });
    // ก้อน 1,000 · a 3 วัน b 1 วัน → 750 / 250
    expect(r.get("a")).toMatchObject({ amount: 750, fullDays: 3, totalFullDays: 4, tierAmount: 1000 });
    expect(r.get("b")!.amount).toBe(250);
  });

  it("ยอดไม่ถึงขั้นแรก = 0 · คนที่ไม่ได้เลือกไม่นับวันทำงาน", () => {
    expect(computeMonthlySalesBonuses({ employees, periodSales: 800_000, tiers, isEligibleOn: () => true, mode: "split" }).get("a")!.amount).toBe(0);
    const r = computeMonthlySalesBonuses({ employees, periodSales: 950_000, tiers, isEligibleOn: (id) => id === "a", mode: "split" });
    expect(r.get("a")!.amount).toBe(1000);
    expect(r.get("b")!.amount).toBe(0);
  });
});

describe("คำนวณทั้งงวด: โหมดหาร + รายเดือน + เลือกพนักงาน", () => {
  const records = [rec("2026-11-01", 8, "u1"), rec("2026-11-02", 8, "u1"), rec("2026-11-01", 8, "u2")];
  const profiles = [prof({ userId: "u1" }), prof({ id: "p2", userId: "u2", employmentType: "temporary", permanentSince: undefined })];
  const input = {
    summaries: [summaryFor(records, "u1"), summaryFor(records, "u2")],
    records,
    profiles,
    adjustments: [],
    settings: hr(),
    ...PERIOD,
  };
  const ctx = (over: Partial<AdvancedPayrollSettings>): AdvancedComputeContext => ({
    settings: { ...settingsWith({ salesBonus: true, monthlySalesBonus: true }), ...over },
    employees: new Map(),
    dailySales: new Map([["2026-11-01", 31000], ["2026-11-02", 36000], ["2026-10-20", 999999]]),
    maxSalesBeforePeriod: 99999,
  });

  it("ไม่เลือกพนักงาน = เฉพาะประจำ (u2 ชั่วคราวไม่ได้) · รายวันแจกรายคน · รายเดือนไม่ถึงขั้น", () => {
    const lines = computeAdvancedPayrollLines(input, ctx({}));
    const u1 = lines.find((l) => l.userId === "u1")!;
    const u2 = lines.find((l) => l.userId === "u2")!;
    expect(u1.salesBonus).toBe(100 + 150);
    expect(u2.salesBonus).toBe(0);
    expect(u1.monthlySalesBonus).toBe(0); // 67,000 < 900,000 (วันนอกงวดไม่นับ)
  });

  it("เลือก u1+u2 + หาร: วันที่ 1 ก้อน 100 หาร 2 · รายเดือนหารตามวัน · รวมในรายได้", () => {
    const lines = computeAdvancedPayrollLines(
      input,
      ctx({ salesBonusUserIds: ["u1", "u2"], salesBonusMode: "split", monthlyBonusMode: "split", monthlyBonusTiers: [{ minSales: 60000, amount: 900 }] }),
    );
    const u1 = lines.find((l) => l.userId === "u1")!;
    const u2 = lines.find((l) => l.userId === "u2")!;
    expect(u1.salesBonus).toBe(50 + 150);
    expect(u2.salesBonus).toBe(50);
    // ก้อน 900 · u1 2 วัน u2 1 วัน → 600 / 300
    expect(u1.monthlySalesBonus).toBe(600);
    expect(u2.monthlySalesBonus).toBe(300);
    expect(u1.monthlySalesBonusDetail).toMatchObject({ periodSales: 67000, totalFullDays: 3 });
    const plain = computeAdvancedPayrollLines(input, null).find((l) => l.userId === "u1")!;
    expect(u1.grossEarnings).toBe(Math.round((plain.basePay + plain.otPay + plain.bonusTotal + 200 + 600) * 100) / 100);
  });

  it("ปิดสวิตช์รายเดือน = ไม่มีโบนัสรายเดือน", () => {
    const lines = computeAdvancedPayrollLines(input, { ...ctx({}), settings: { ...settingsWith({ salesBonus: true }), monthlyBonusTiers: [{ minSales: 1, amount: 900 }] } });
    expect(lines.every((l) => l.monthlySalesBonus === 0)).toBe(true);
  });
});

describe("ตั้งค่า + migration โบนัสหาร/รายเดือน", () => {
  it("ค่าเริ่มต้นตรงกับพฤติกรรมเดิม และอ่านแถวเก่าได้", () => {
    const old = mapAdvancedSettings({ feat_sales_bonus: true });
    expect(old.salesBonusMode).toBe("per_person");
    expect(old.salesBonusUserIds).toBeNull();
    expect(old.monthlyBonusMode).toBe("per_person");
    expect(old.switches.monthlySalesBonus).toBe(false);
    const row = mapAdvancedSettings({
      feat_monthly_sales_bonus: true,
      sales_bonus_mode: "split",
      sales_bonus_user_ids: ["u1", 5],
      monthly_bonus_tiers: [{ minSales: 500000, amount: 800 }],
      monthly_bonus_mode: "split",
    });
    expect(row).toMatchObject({ salesBonusMode: "split", salesBonusUserIds: ["u1"], monthlyBonusMode: "split", monthlyBonusTiers: [{ minSales: 500000, amount: 800 }] });
    expect(row.switches.monthlySalesBonus).toBe(true);
  });

  it("migration: คอลัมน์ใหม่ default = แบบเดิม + check โหมด", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261110130000_payroll_bonus_split_monthly.sql"), "utf8");
    expect(sql).toContain("sales_bonus_mode text not null default 'per_person'");
    expect(sql).toContain("feat_monthly_sales_bonus boolean not null default false");
    expect(sql).toContain("sales_bonus_user_ids uuid[]");
    expect(sql).toContain("monthly_bonus_mode in ('per_person', 'split')");
  });

  it("action: รายชื่อที่เลือกกรองเหลือเฉพาะพนักงานของสาขา · บันทึกครบ", () => {
    const src = readFileSync(join(process.cwd(), "src/app/(dashboard)/staff/advanced-actions.ts"), "utf8");
    expect(src).toContain("listStoreMemberships(ctx.organizationId, ctx.storeId)");
    expect(src).toContain("picked.filter((id) => allowed.has(id))");
    // โบนัสปิด + ไม่เลือกใคร → ไม่เก็บรายชื่อว่าง (กลับเป็นพนักงานประจำ)
    expect(src).toContain("if (salesBonusUserIds.length === 0) salesBonusUserIds = null;");
    const repo = readFileSync(join(process.cwd(), "src/modules/hr/advanced/repository.ts"), "utf8");
    for (const col of ["feat_monthly_sales_bonus", "sales_bonus_mode", "sales_bonus_user_ids", "monthly_bonus_tiers", "monthly_bonus_mode"]) {
      expect(repo).toContain(`${col}:`);
    }
  });
});

// ---------------------------------------------------------------------------
// จ่ายรายสัปดาห์ (Plan/Weekly Pay Plan v1.html · W1–W9)
// ---------------------------------------------------------------------------
describe("จ่ายค่าแรงรายสัปดาห์", () => {
  const WEEK = weekContaining("2026-11-11", 1); // จันทร์ 9 – อาทิตย์ 15 พ.ย.
  const weekInput = (records: AttendanceRecord[], profiles: EmployeeProfile[], adjustments: PayrollAdjustment[] = []) => ({
    summaries: [...new Set(profiles.map((p) => p.userId))].map((u) => summaryFor(records, u)),
    records,
    profiles,
    adjustments,
    settings: hr({ halfDayMaxHours: 4 }),
    periodStart: WEEK.start,
    periodEnd: WEEK.end,
    today: "2026-11-20",
    timezone: TZ,
  });
  const weeklyCtx = (over: Partial<AdvancedPayrollSettings> = {}): AdvancedComputeContext => ({
    settings: { ...settingsWith({ weeklyPay: true }), ...over },
    employees: new Map(),
    dailySales: new Map(),
    maxSalesBeforePeriod: 0,
  });
  const run = (input: ReturnType<typeof weekInput>, rateBasis: "profile" | "working_days" = "profile") =>
    computeWeeklyPayouts({
      week: WEEK,
      lines: computeAdvancedPayrollLines(input, weeklyCtx()),
      profiles: input.profiles,
      hrSettings: input.settings,
      rateBasis,
      payCycleStartDay: 1,
      payDay: 0,
    });

  it("สัปดาห์ตามวันเริ่มที่ร้านเลือก", () => {
    expect(WEEK).toEqual({ start: "2026-11-09", end: "2026-11-15" });
    expect(weekContaining("2026-11-11", 0)).toEqual({ start: "2026-11-08", end: "2026-11-14" });
    expect(weekContaining("2026-11-08", 0).start).toBe("2026-11-08");
    expect(weekContaining("2026-11-09", 1)).toEqual({ start: "2026-11-09", end: "2026-11-15" });
    expect(previousWeek(WEEK)).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(recentWeeks("2026-11-11", 1, 3).map((w) => w.start)).toEqual(["2026-11-09", "2026-11-02", "2026-10-26"]);
  });

  it("ค่าแรงต่อวันพนักงานเงินเดือน: ÷30 / เรทรายวันในโปรไฟล์ / ÷ วันทำงานในงวด", () => {
    const base = { monthlySalary: 15000, dailyRate: 0, workingDays: [] as number[] };
    const opts = { storeWorkingDays: [1, 2, 3, 4, 5, 6], payCycleStartDay: 1, payDay: 0 };
    expect(monthlyDailyRate(base, "2026-11-10", { basis: "profile", ...opts })).toBe(500);
    expect(monthlyDailyRate({ ...base, dailyRate: 450 }, "2026-11-10", { basis: "profile", ...opts })).toBe(450);
    // พ.ย. 2026 มีวันอาทิตย์ 5 วัน → วันทำงาน 25 วัน
    expect(monthlyDailyRate(base, "2026-11-10", { basis: "working_days", ...opts })).toBe(600);
  });

  it("แยกรอบ: นับเฉพาะวันที่มา (เต็ม 1 ครึ่ง 0.5) ขาด/วันหยุดไม่นับ ไม่หักค่าปรับ + รวมรายการมือ", () => {
    const records = [rec("2026-11-09", 8), rec("2026-11-10", 4)];
    const bonus = { id: "a1", userId: "u1", date: "2026-11-10", type: "bonus", amount: 100 } as PayrollAdjustment;
    const [p] = run(weekInput(records, [prof({ payFrequency: "weekly", workingDays: [1, 2, 3, 4, 5, 6] })], [bonus]));
    expect(p).toMatchObject({ mode: "weekly", fullDays: 1, halfDays: 1, workedDays: 1.5, basePay: 750, adjustmentsNet: 100, amount: 850 });
    expect(p.days.find((d) => d.date === "2026-11-11")).toMatchObject({ status: "absent", units: 0, pay: 0 });
  });

  it("ล่วงหน้า: ไม่รวมรายการมือ (ไปอยู่ในงวดรายเดือน) · ฐาน ÷ วันทำงาน", () => {
    const records = [rec("2026-11-09", 8)];
    const bonus = { id: "a1", userId: "u1", date: "2026-11-10", type: "bonus", amount: 100 } as PayrollAdjustment;
    const input = weekInput(records, [prof({ payFrequency: "weekly_advance", workingDays: [1, 2, 3, 4, 5, 6] })], [bonus]);
    const [p] = run(input, "working_days");
    expect(p).toMatchObject({ mode: "weekly_advance", workedDays: 1, basePay: 600, adjustmentsNet: 0, amount: 600 });
  });

  it("รายวัน: เรทรายวัน × วันที่มา + OT · คนรอบรายเดือนไม่อยู่ในผล", () => {
    const records = [rec("2026-11-09", 10, "u1"), rec("2026-11-12", 8, "u1"), rec("2026-11-09", 8, "u2")];
    const profiles = [
      prof({ payType: "daily", dailyRate: 400, monthlySalary: 0, otEligible: true, payFrequency: "weekly" }),
      prof({ id: "p2", userId: "u2" }),
    ];
    const out = run(weekInput(records, profiles));
    expect(out.map((p) => p.userId)).toEqual(["u1"]);
    // OT 2 ชม. × 1.5 × (400/8)
    expect(out[0]).toMatchObject({ workedDays: 2, basePay: 800, otPay: 150, amount: 950 });
  });

  it("งวดรายเดือน: หักยอดจ่ายล่วงหน้า · แยกรอบติดป้าย (เฉพาะเมื่อเปิดสวิตช์)", () => {
    const records = [rec("2026-11-01", 8, "u1"), rec("2026-11-01", 8, "u2")];
    const profiles = [prof({ payFrequency: "weekly_advance" }), prof({ id: "p2", userId: "u2", payFrequency: "weekly" })];
    const input = { summaries: [summaryFor(records, "u1"), summaryFor(records, "u2")], records, profiles, adjustments: [], settings: hr(), ...PERIOD };
    const plain = computeAdvancedPayrollLines(input, { ...weeklyCtx(), weeklyAdvances: new Map() });
    const lines = computeAdvancedPayrollLines(input, { ...weeklyCtx(), weeklyAdvances: new Map([["u1", 1234.5]]) });
    const u1 = lines.find((l) => l.userId === "u1")!;
    expect(u1.weeklyAdvance).toBe(1234.5);
    expect(u1.netPay).toBe(Math.round((plain.find((l) => l.userId === "u1")!.netPay - 1234.5) * 100) / 100);
    expect(lines.find((l) => l.userId === "u2")!.paidWeekly).toBe(true);
    const off = computeAdvancedPayrollLines(input, { ...weeklyCtx(), settings: settingsWith({}) });
    expect(off.some((l) => l.paidWeekly)).toBe(false);
  });

  it("ลาออกกลางสัปดาห์: นับเฉพาะวันถึงวันออก · ลาออกก่อนสัปดาห์ = ไม่มียอด", () => {
    const records = [rec("2026-11-09", 8), rec("2026-11-10", 8), rec("2026-11-12", 8)];
    const [p] = run(weekInput(records, [prof({ payFrequency: "weekly", employmentEndDate: "2026-11-10" })]));
    expect(p).toMatchObject({ workedDays: 2, basePay: 1000 });
    expect(run(weekInput(records, [prof({ payFrequency: "weekly", employmentEndDate: "2026-11-01" })]))).toEqual([]);
  });

  it("รายละเอียดรายวัน: รายชั่วโมง/รายวัน กระจายยอดรวมแล้วเท่ากับค่าแรงพื้นฐาน", () => {
    const records = [rec("2026-11-09", 6), rec("2026-11-10", 3)];
    const [h] = run(weekInput(records, [prof({ payType: "hourly", hourlyRate: 100, monthlySalary: 0, payFrequency: "weekly_advance" })]));
    expect(h.basePay).toBe(900);
    expect(h.days.filter((d) => d.units > 0).every((d) => d.pay > 0)).toBe(true);
    expect(h.days.reduce((s, d) => s + d.pay, 0)).toBe(900);
    expect(h.days.find((d) => d.date === "2026-11-09")!.pay).toBe(600);
    // หารไม่ลงตัว: 3 วันเท่ากัน ยอด 1,000 → เศษไปวันสุดท้าย ผลรวมยังเท่าเดิม
    const three = [rec("2026-11-09", 8), rec("2026-11-10", 8), rec("2026-11-11", 8)];
    const [d] = run(weekInput(three, [prof({ payType: "hourly", hourlyRate: 1000 / 24, monthlySalary: 0, payFrequency: "weekly" })]));
    expect(Math.round(d.days.reduce((s, x) => s + x.pay, 0) * 100) / 100).toBe(d.basePay);
  });

  it("ล่วงหน้า + OT: amount = ค่าแรงพื้นฐาน + OT (ไม่รวมรายการมือ)", () => {
    const records = [rec("2026-11-09", 10)];
    const bonus = { id: "a1", userId: "u1", date: "2026-11-09", type: "bonus", amount: 100 } as PayrollAdjustment;
    const [p] = run(weekInput(records, [prof({ payType: "daily", dailyRate: 400, monthlySalary: 0, otEligible: true, payFrequency: "weekly_advance" })], [bonus]));
    expect(p).toMatchObject({ basePay: 400, otPay: 150, adjustmentsNet: 0, amount: 550 });
  });

  it("cron บันทึกอัตโนมัติเฉพาะสัปดาห์ที่จบตั้งแต่วันเปิดสวิตช์", () => {
    expect(isWeekAutoRecordable(WEEK, null)).toBe(true);
    expect(isWeekAutoRecordable(WEEK, "2026-11-15")).toBe(true); // เปิดวันสุดท้ายของสัปดาห์ = บันทึก
    expect(isWeekAutoRecordable(WEEK, "2026-11-16")).toBe(false);
  });

  it("ข้อความแจ้งเจ้าของ: จำนวนคน ยอดรวม และยอดต่อคน", () => {
    const msg = weeklyOwnerMessage(
      [
        { employeeName: "สมชาย", amount: 1800, workedDays: 4.5 },
        { employeeName: "มานี", amount: 1350, workedDays: 3 },
      ],
      (n) => `฿${n}`,
    );
    expect(msg).toBe("2 คน · รวม ฿3150 — สมชาย ฿1800 (4.5 วัน) · มานี ฿1350 (3 วัน)");
  });

  it("ตั้งค่า: อาทิตย์ (0) อ่านได้ถูก · ค่าเริ่มต้นจันทร์ + ตามโปรไฟล์ + สวิตช์ปิด", () => {
    expect(mapAdvancedSettings({ weekly_start_day: 0 }).weeklyStartDay).toBe(0);
    const d = mapAdvancedSettings({});
    expect(d).toMatchObject({ weeklyStartDay: 1, weeklyRateBasis: "profile" });
    expect(d.switches.weeklyPay).toBe(false);
    expect(mapAdvancedSettings({ feat_weekly_pay: true, weekly_rate_basis: "working_days" })).toMatchObject({ weeklyRateBasis: "working_days" });
    expect(parsePayFrequency("weekly_advance")).toBe("weekly_advance");
    expect(parsePayFrequency("x")).toBe("monthly");
  });

  it("migration + เส้นทางระบบ: ค่าเริ่มต้นแบบเดิม, ปิดงวดข้ามคนแยกรอบ, cron บันทึกครั้งเดียวต่อสัปดาห์", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261111000000_payroll_weekly_pay.sql"), "utf8");
    expect(sql).toContain("pay_frequency text not null default 'monthly'");
    expect(sql).toContain("feat_weekly_pay boolean not null default false");
    expect(sql).toContain("unique (store_id, user_id, week_start)");
    expect(sql).toContain("payroll_weekly_payouts_store_org_fk");
    const close = readFileSync(join(process.cwd(), "src/modules/hr/advanced/close-period.ts"), "utf8");
    expect(close).toContain("!l.paidWeekly");
    const cron = readFileSync(join(process.cwd(), "src/modules/hr/advanced/cron.ts"), "utf8");
    expect(cron).toContain('hasPayrollNotification(c.storeId, "weekly_recorded", week.start)');
    expect(cron).toContain("isWeekAutoRecordable(week, settings.weeklyPayEnabledAt)");
    const repo = readFileSync(join(process.cwd(), "src/modules/hr/advanced/repository.ts"), "utf8");
    // deploy ก่อน migration ต้องไม่ทำหน้าเงินเดือนล่ม
    expect(repo).toContain('error.code === "42P01" || error.code === "PGRST205"');
    const action = readFileSync(join(process.cwd(), "src/app/(dashboard)/staff/advanced-actions.ts"), "utf8");
    expect(action).toContain("ปิดไปแล้ว — บันทึกสัปดาห์นี้ไม่ได้");
    expect(action).toContain('.eq("pay_frequency", "weekly_advance")');
    const store = readFileSync(join(process.cwd(), "src/modules/hr/advanced/store-payroll.ts"), "utf8");
    expect(store).toContain("loadWeeklyAdvances(storeId, periodStart, periodEnd)");
  });
});

// ---------------------------------------------------------------------------
// เริ่มงานกลางงวด: ไม่นับขาดก่อนวันเริ่มงาน · เงินเดือนคิดตามสัดส่วนวัน
// ---------------------------------------------------------------------------
describe("เงินเดือน: เริ่มงานกลางงวด", () => {
  const NOV = { periodStart: "2026-11-01", periodEnd: "2026-11-30", today: "2026-12-05", timezone: TZ };
  const make = (profiles: EmployeeProfile[], records: AttendanceRecord[], joined?: Map<string, string>) => ({
    summaries: [...new Set(profiles.map((p) => p.userId))].map((u) => summaryFor(records, u)),
    records,
    profiles,
    adjustments: [],
    settings: hr(),
    ...NOV,
    joinedDates: joined,
  });

  it("เงินเดือน: เริ่ม 16 พ.ย. = 15/30 ของเงินเดือน · ไม่มีขาดก่อนวันเริ่ม", () => {
    const records = ["2026-11-16", "2026-11-17"].map((d) => rec(d, 8));
    const [l] = computeAdvancedPayrollLines(make([prof({ seniorityStartDate: "2026-11-16", workingDays: [0, 1, 2, 3, 4, 5, 6] })], records), null);
    expect(l.basePay).toBe(7500);
    expect(l.days[0].date).toBe("2026-11-16");
    expect(l.days.every((d) => d.date >= "2026-11-16")).toBe(true);
    // ขาด 18–30 พ.ย. (13 วัน) × 7500/15
    expect(l.absentDays).toBe(13);
    expect(l.absentPenalty).toBe(6500);
  });

  it("รายวัน: วันก่อนเริ่มงานไม่ถูกนับเป็นขาด (ใช้วันเข้าร่วมร้านเมื่อวันเริ่มงานยังไม่ตั้ง)", () => {
    const records = [rec("2026-11-20", 8)];
    const p = prof({ payType: "daily", dailyRate: 400, monthlySalary: 0, seniorityStartDate: undefined, workingDays: [0, 1, 2, 3, 4, 5, 6] });
    const [l] = computeAdvancedPayrollLines(make([p], records, new Map([["u1", "2026-11-20"]])), null);
    expect(l.basePay).toBe(400);
    expect(l.absentDays).toBe(10); // 21–30 พ.ย.
  });

  it("มีลงเวลาก่อนวันเริ่มงาน = เริ่มคิดตั้งแต่วันลงเวลาแรก (ทำงานจริงต้องได้เงิน)", () => {
    const records = [rec("2026-11-10", 8), rec("2026-11-16", 8)];
    const p = prof({ payType: "daily", dailyRate: 400, monthlySalary: 0, seniorityStartDate: "2026-11-16", workingDays: [] });
    const [l] = computeAdvancedPayrollLines(make([p], records), null);
    expect(l.basePay).toBe(800);
    expect(l.days[0].date).toBe("2026-11-10");
  });

  it("เริ่มหลังงวดจบ = ไม่มีบรรทัด · เริ่มก่อนงวด = เหมือนเดิมทุกบาท", () => {
    expect(computeAdvancedPayrollLines(make([prof({ seniorityStartDate: "2026-12-02" })], []), null)).toEqual([]);
    const records = [rec("2026-11-02", 8)];
    const before = make([prof({ seniorityStartDate: "2025-01-01" })], records);
    const legacy = computePayrollLines(before);
    expect(computeAdvancedPayrollLines(before, null).map((l) => l.netPay)).toEqual(legacy.map((l) => l.netPay));
  });

  it("เริ่มและออกในงวดเดียวกัน = คิดเฉพาะช่วงนั้น", () => {
    const p = prof({ seniorityStartDate: "2026-11-11", employmentEndDate: "2026-11-20", workingDays: [] });
    const [l] = computeAdvancedPayrollLines(make([p], [rec("2026-11-12", 8)]), null);
    expect(l.basePay).toBe(5000); // 10/30 × 15,000
    expect(l.days.map((d) => d.date)[0]).toBe("2026-11-11");
    expect(l.days.at(-1)!.date).toBe("2026-11-20");
  });

  it("ขึ้นเงินเดือนกลางงวด + เริ่มงานกลางงวด: ฐาน 30 วันตามช่วงที่ทำงานจริง", () => {
    const records = [rec("2026-11-16", 8)];
    const input = make([prof({ seniorityStartDate: "2026-11-16", workingDays: [] })], records);
    const ctx: AdvancedComputeContext = {
      settings: settingsWith({}),
      employees: new Map([["u1", { skills: [], rates: [
        { payType: "monthly", monthlySalary: 15000, dailyRate: 0, hourlyRate: 0, effectiveFrom: "2026-01-01" },
        { payType: "monthly", monthlySalary: 18000, dailyRate: 0, hourlyRate: 0, effectiveFrom: "2026-11-21" },
      ] }]]),
      dailySales: new Map(),
      maxSalesBeforePeriod: 0,
    };
    const [l] = computeAdvancedPayrollLines(input, ctx);
    // 16–20 พ.ย. 5 วัน × 15,000/30 + 21–30 พ.ย. 10 วัน × 18,000/30 = 2,500 + 6,000
    expect(l.basePay).toBe(8500);
  });

  it("เริ่มงานกลางงวด + ยังไม่จบงวด: ขาดนับถึงวันนี้เท่านั้น", () => {
    const input = { ...make([prof({ seniorityStartDate: "2026-11-16", workingDays: [0, 1, 2, 3, 4, 5, 6] })], [rec("2026-11-16", 8)]), today: "2026-11-22" };
    const [l] = computeAdvancedPayrollLines(input, null);
    expect(l.absentDays).toBe(6); // 17–22 พ.ย.
  });

  it("ออกงาน 15 พ.ย.: ไม่มีวันหลังวันออกงาน แม้วันนี้เลยงวดไปแล้ว", () => {
    const [l] = computeAdvancedPayrollLines(make([prof({ employmentEndDate: "2026-11-15", workingDays: [0, 1, 2, 3, 4, 5, 6] })], []), null);
    expect(l.days.length).toBe(15);
    expect(l.days.every((d) => d.date <= "2026-11-15")).toBe(true);
  });

  it("หลายเรท + ตัดงวดในเดือน 28 วัน: ฐาน 30 วัน (ตรงกับแบบเรทเดียว)", () => {
    const FEB = { periodStart: "2027-02-01", periodEnd: "2027-02-28", today: "2027-03-05", timezone: TZ };
    const input = {
      summaries: [summaryFor([rec("2027-02-16", 8)], "u1")],
      records: [rec("2027-02-16", 8)],
      profiles: [prof({ seniorityStartDate: "2027-02-15", workingDays: [] })],
      adjustments: [],
      settings: hr(),
      ...FEB,
    };
    const ctx: AdvancedComputeContext = {
      settings: settingsWith({}),
      employees: new Map([["u1", { skills: [], rates: [
        { payType: "monthly", monthlySalary: 15000, dailyRate: 0, hourlyRate: 0, effectiveFrom: "2026-01-01" },
        { payType: "monthly", monthlySalary: 18000, dailyRate: 0, hourlyRate: 0, effectiveFrom: "2027-02-21" },
      ] }]]),
      dailySales: new Map(),
      maxSalesBeforePeriod: 0,
    };
    const [l] = computeAdvancedPayrollLines(input, ctx);
    // 15–20 ก.พ. 6 วัน × 500 + 21–28 ก.พ. 8 วัน × 600
    expect(l.basePay).toBe(7800);
    // เรทเดียวในช่วงเดียวกัน (14 วัน) = 14/30 × 15,000
    expect(computeAdvancedPayrollLines(input, null)[0].basePay).toBe(7000);
  });

  it("ช่วงคิดเงิน + วันเข้าร่วมร้าน: ใช้วันที่ช้ากว่า · แถวผูกสาขาก่อนระดับองค์กร · เวลาสาขา", () => {
    expect(payrollWindowFor({ seniorityStartDate: "2024-01-01" }, "2026-11-09", undefined, "2026-11-01", "2026-11-30")).toEqual({ from: "2026-11-09", to: "2026-11-30" });
    expect(payrollWindowFor({ seniorityStartDate: "2026-11-12" }, "2026-11-09", undefined, "2026-11-01", "2026-11-30").from).toBe("2026-11-12");
    expect(payrollWindowFor({}, undefined, undefined, "2026-11-01", "2026-11-30")).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    const m = joinedDatesFromMembers(
      [
        { userId: "u1", joinedAt: "2026-01-01T00:00:00Z", storeId: null },
        { userId: "u1", joinedAt: "2026-11-08T18:30:00Z", storeId: "s1" },
        { userId: "u2", joinedAt: null, storeId: "s1" },
      ],
      TZ,
    );
    expect(m.get("u1")).toBe("2026-11-09");
    expect(m.has("u2")).toBe(false);
  });

  it("ทุกจุดที่คำนวณเงินเดือนส่งวันเข้าร่วมร้าน (หน้าพนักงาน, สลิป, ปิดงวด/cron/รายสัปดาห์)", () => {
    for (const f of ["src/app/(dashboard)/staff/page.tsx", "src/app/payslip/page.tsx", "src/modules/hr/advanced/store-payroll.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).toContain("joinedDates: joinedDatesFromMembers(");
    }
  });
});
