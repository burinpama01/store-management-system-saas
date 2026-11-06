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
} from "@/modules/hr/advanced/income";
import { computeAdvancedPayrollLines, type AdvancedComputeContext } from "@/modules/hr/advanced/compute";
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
