/**
 * เงินเดือนขั้นสูง = computePayrollLines เดิม + ประวัติเรท + ②③④ + ประกันสังคม/ภาษี
 * ไม่มี context ขั้นสูง (แพ็กไม่มีสิทธิ์/ปิดทุกสวิตช์) = ผลลัพธ์เท่าเดิมทุกบาท
 */
import {
  computePayrollLines,
  effectiveHourlyRate,
  isHalfDay,
  type PayrollComputeInput,
  type PayrollLine,
} from "../payroll";
import type { EmployeeProfile } from "../types";
import type { AdvancedPayrollSettings, SeniorityTier, SkillTier } from "./settings";
import {
  activeSkillsOn,
  computeStoreSalesDays,
  employeeSalesBonus,
  fullMonthsBetween,
  hasMultipleRates,
  isPermanentOn,
  nextTier,
  rateOn,
  rateSegments,
  seniorityPayFor,
  skillPayFor,
  socialSecurityFor,
  withholdingTaxPercent,
  type EmployeeSkillGrant,
  type PayRateEntry,
} from "./income";
import { addDays, daysInclusive } from "./pay-cycle";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AdvancedEmployeeData {
  skills: EmployeeSkillGrant[];
  rates: PayRateEntry[];
}

export interface AdvancedComputeContext {
  /** สวิตช์ที่มีผลจริงแล้ว (ผ่าน effectiveSwitches) */
  settings: AdvancedPayrollSettings;
  employees: Map<string, AdvancedEmployeeData>;
  /** ยอดขายต่อวันทำการ ของงวดนี้ */
  dailySales: Map<string, number>;
  /** ยอดสูงสุดต่อวันก่อนเริ่มงวด (ตัดสินทำสถิติ) */
  maxSalesBeforePeriod: number;
}

export interface AdvancedPayrollLine extends PayrollLine {
  skillPay: number;
  skillNames: string[];
  /** ทักษะที่ได้ระหว่าง/หลังวันแรกของงวด — มีผลงวดถัดไป (R9) */
  pendingSkillNames: string[];
  nextSkillTier: SkillTier | null;
  seniorityPay: number;
  seniorityMonths: number;
  nextSeniorityTier: SeniorityTier | null;
  salesBonus: number;
  salesBonusDays: { date: string; amount: number; record: boolean }[];
  socialSecurity: number;
  socialSecurityBase: number;
  withholdingTax: number;
  /** ช่วงเรทในงวดนี้ (แสดงเมื่อขึ้น/ลดเงินเดือนกลางงวด) */
  rateSegments: { from: string; to: string; days: number; label: string }[];
  grossEarnings: number;
  totalDeductions: number;
  /** เป็นพนักงานประจำ ณ วันแรกของงวด */
  permanentAtPeriodStart: boolean;
}

/** สรุปชั่วโมง/วันของคนที่ลาออกกลางงวด — นับเฉพาะ record ถึงวันออกงาน */
function computePayrollSummariesFor(
  summaries: PayrollComputeInput["summaries"],
  userId: string,
  records: PayrollComputeInput["records"],
): PayrollComputeInput["summaries"] {
  const original = summaries.find((s) => s.userId === userId);
  if (!original) return [];
  let totalMs = 0;
  const dates = new Set<string>();
  for (const r of records) {
    if (!r.clockOutAt) continue;
    const ms = Date.parse(r.clockOutAt) - Date.parse(r.clockInAt);
    if (ms > 0) {
      totalMs += ms;
      dates.add(r.date);
    }
  }
  return [{ ...original, totalHours: round2(totalMs / 3_600_000), totalDays: dates.size }];
}

function profileRate(p: EmployeeProfile): PayRateEntry {
  return {
    payType: p.payType,
    monthlySalary: p.monthlySalary,
    dailyRate: p.dailyRate,
    hourlyRate: p.hourlyRate,
    effectiveFrom: "0000-01-01",
  };
}

function rateLabel(r: PayRateEntry): string {
  if (r.payType === "monthly") return `เงินเดือน ${r.monthlySalary.toLocaleString("th-TH")}`;
  if (r.payType === "daily") return `วันละ ${r.dailyRate.toLocaleString("th-TH")}`;
  return `ชั่วโมงละ ${r.hourlyRate.toLocaleString("th-TH")}`;
}

function emptyExtras(line: PayrollLine): AdvancedPayrollLine {
  return {
    ...line,
    skillPay: 0,
    skillNames: [],
    pendingSkillNames: [],
    nextSkillTier: null,
    seniorityPay: 0,
    seniorityMonths: 0,
    nextSeniorityTier: null,
    salesBonus: 0,
    salesBonusDays: [],
    socialSecurity: 0,
    socialSecurityBase: 0,
    withholdingTax: 0,
    rateSegments: [],
    grossEarnings: round2(line.basePay + line.otPay + line.bonusTotal),
    totalDeductions: round2(line.latePenalty + line.absentPenalty + line.halfDayDeduction + line.deductionTotal),
    permanentAtPeriodStart: false,
  };
}

export function computeAdvancedPayrollLines(
  input: PayrollComputeInput,
  adv?: AdvancedComputeContext | null,
): AdvancedPayrollLine[] {
  const { periodStart, periodEnd, settings } = input;
  const periodDays = daysInclusive(periodStart, periodEnd);

  // 1) ประวัติเรท: เรทเดียวทั้งงวด → แทนค่าในโปรไฟล์แล้วใช้สูตรเดิม; หลายเรท → คิดแยกช่วงด้านล่าง
  const multiRate = new Map<string, ReturnType<typeof rateSegments>>();
  const profiles = input.profiles.map((p) => {
    const rates = adv?.employees.get(p.userId)?.rates ?? [];
    if (rates.length === 0) return p;
    const segs = rateSegments(rates, periodStart, periodEnd, profileRate(p));
    if (hasMultipleRates(segs)) {
      multiRate.set(p.userId, segs);
      const last = segs[segs.length - 1].rate;
      return { ...p, payType: last.payType, monthlySalary: last.monthlySalary, dailyRate: last.dailyRate, hourlyRate: last.hourlyRate };
    }
    const r = segs[0].rate;
    return { ...p, payType: r.payType, monthlySalary: r.monthlySalary, dailyRate: r.dailyRate, hourlyRate: r.hourlyRate };
  });
  const profileByUser = new Map(profiles.map((p) => [p.userId, p]));

  // R27 ลาออก: ออกก่อนงวดเริ่ม = ไม่มีบรรทัดในงวดนี้; ออกระหว่างงวด = คิดถึงวันออกงาน (ไม่นับขาดหลังวันออก)
  const endedBefore = new Set(
    profiles.filter((p) => p.employmentEndDate && p.employmentEndDate < periodStart).map((p) => p.userId),
  );
  const endsInside = profiles.filter(
    (p) => p.employmentEndDate && p.employmentEndDate >= periodStart && p.employmentEndDate < periodEnd,
  );
  const clipped = new Set(endsInside.map((p) => p.userId));
  const keep = <T extends { userId: string }>(rows: T[], exclude: Set<string>) => rows.filter((r) => !exclude.has(r.userId));
  const excludeMain = new Set([...endedBefore, ...clipped]);
  const baseLines = computePayrollLines({
    ...input,
    profiles: keep(profiles, excludeMain),
    summaries: keep(input.summaries, excludeMain),
    records: keep(input.records, excludeMain),
    adjustments: keep(input.adjustments, excludeMain),
  });
  for (const p of endsInside) {
    const end = p.employmentEndDate as string;
    const only = <T extends { userId: string }>(rows: T[]) => rows.filter((r) => r.userId === p.userId && (!("date" in r) || String((r as { date?: string }).date) <= end));
    baseLines.push(
      ...computePayrollLines({
        ...input,
        profiles: [p],
        summaries: computePayrollSummariesFor(input.summaries, p.userId, input.records.filter((r) => r.userId === p.userId && r.date <= end)),
        records: only(input.records),
        adjustments: only(input.adjustments),
        periodEnd: end,
        today: input.today < end ? input.today : end,
      }),
    );
  }
  baseLines.sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  // ระดับสาขา: ยอดขายต่อวัน → ขั้นโบนัส/สถิติ (คิดครั้งเดียวทั้งร้าน)
  const sw = adv?.settings.switches;
  const storeDays =
    adv && sw?.salesBonus
      ? computeStoreSalesDays({
          dailySales: adv.dailySales,
          dates: Array.from({ length: periodDays }, (_, i) => addDays(periodStart, i)),
          tiers: adv.settings.salesBonusTiers,
          recordBaseline: adv.settings.salesRecordBaseline,
          maxBeforePeriod: adv.maxSalesBeforePeriod,
          recordBonus: adv.settings.salesRecordBonus,
          recordMode: adv.settings.salesRecordMode,
        })
      : null;

  return baseLines.map((base) => {
    const line = emptyExtras(base);
    const profile = profileByUser.get(base.userId);
    if (!profile) return line;

    // 2) ขึ้น/ลดเงินเดือนกลางงวด (R29: ตามจำนวนวันจริงในงวด)
    const segs = multiRate.get(base.userId);
    if (segs) {
      line.rateSegments = segs.map((s) => ({ from: s.from, to: s.to, days: s.days, label: rateLabel(s.rate) }));
      const reg = settings.regularHoursPerDay;
      const otOn = profile.otEligible && settings.otDailyCapHours > 0;
      const rates = adv?.employees.get(base.userId)?.rates ?? [];
      const at = (date: string) => rateOn(rates, date) ?? profileRate(input.profiles.find((p) => p.userId === base.userId) ?? profile);
      let newBase = 0;
      let otPay = 0;
      let otHours = 0;
      let regularHours = 0;
      if (profile.payType === "monthly") {
        newBase = segs.reduce((sum, s) => sum + (s.rate.monthlySalary * s.days) / periodDays, 0);
      }
      for (const day of base.days) {
        if (!(day.hours > 0)) continue;
        const r = at(day.date);
        const otD = otOn ? Math.min(Math.max(0, day.hours - reg), settings.otDailyCapHours) : 0;
        const hourly = effectiveHourlyRate({ ...profile, ...r }, reg);
        otHours += otD;
        otPay += otD * settings.otMultiplier * hourly;
        if (profile.payType === "daily") {
          newBase += (isHalfDay(day.hours, settings.halfDayMaxHours ?? 0) ? 0.5 : 1) * r.dailyRate;
        } else if (profile.payType === "hourly") {
          newBase += (day.hours - otD) * r.hourlyRate;
          regularHours += day.hours - otD;
        }
      }
      const oldBase = line.basePay;
      line.basePay = round2(newBase);
      line.otPay = round2(otPay);
      line.otHours = round2(otHours);
      if (profile.payType === "hourly") line.regularHours = round2(regularHours);
      // ค่าหักขาด/ครึ่งวันของรายเดือนคิดจากฐานเงินเดือน → ปรับตามฐานใหม่
      if (profile.payType === "monthly" && !(profile.absentPenaltyAmount > 0) && oldBase > 0) {
        const perDay = (line.absentRatePerDay * line.basePay) / oldBase;
        line.absentRatePerDay = round2(perDay);
        line.absentPenalty = round2(line.absentDays * perDay);
        line.halfDayDeduction = round2(0.5 * line.halfDayDeductionDays * perDay);
      }
    }

    // 3) ②③④
    const permanentAtStart = isPermanentOn(profile, periodStart);
    line.permanentAtPeriodStart = permanentAtStart;
    const data = adv?.employees.get(base.userId);
    if (adv && sw) {
      if (sw.skillPay) {
        const active = activeSkillsOn(data?.skills ?? [], periodStart);
        line.skillNames = active.map((s) => s.skillName);
        line.pendingSkillNames = (data?.skills ?? [])
          .filter((s) => s.grantedAt > periodStart && !s.revokedAt)
          .map((s) => s.skillName);
        line.nextSkillTier = nextTier(active.length, adv.settings.skillTiers, "count");
        if (permanentAtStart) line.skillPay = skillPayFor(active.length, adv.settings.skillTiers);
      }
      if (sw.seniorityPay) {
        line.seniorityMonths = fullMonthsBetween(profile.seniorityStartDate, periodStart);
        line.nextSeniorityTier = nextTier(line.seniorityMonths, adv.settings.seniorityTiers, "months");
        if (permanentAtStart) line.seniorityPay = seniorityPayFor(line.seniorityMonths, adv.settings.seniorityTiers);
      }
      if (sw.salesBonus && storeDays) {
        const bonus = employeeSalesBonus({
          days: base.days,
          storeDays,
          isEligibleOn: (date) => isPermanentOn(profile, date),
          lateMaxMinutes: adv.settings.salesBonusLateMaxMinutes,
        });
        line.salesBonus = bonus.total;
        line.salesBonusDays = bonus.days;
      }
    }

    line.grossEarnings = round2(
      line.basePay + line.otPay + line.bonusTotal + line.skillPay + line.seniorityPay + line.salesBonus,
    );
    // รายได้ที่ได้จริง (ใช้เป็นฐานประกันสังคม/ภาษี) = รายได้รวม − หักขาด/ครึ่งวัน (ไม่หักค่าปรับ)
    const earned = Math.max(0, line.grossEarnings - line.absentPenalty - line.halfDayDeduction);

    // 4) ประกันสังคม / ภาษี (R18, R19, R28)
    if (adv && sw?.socialSecurity && profile.ssoEnabled !== false) {
      const sso = socialSecurityFor(earned, {
        rate: adv.settings.ssoRate,
        floor: adv.settings.ssoWageFloor,
        ceiling: adv.settings.ssoWageCeiling,
      });
      line.socialSecurity = sso.amount;
      line.socialSecurityBase = sso.base;
    }
    if (adv && sw?.withholdingTax) {
      line.withholdingTax =
        adv.settings.whtMode === "percent"
          ? withholdingTaxPercent(earned, profile.withholdingTaxRate ?? 0)
          : round2(base.adjustments.filter((a) => a.type === "withholding_tax").reduce((s, a) => s + a.amount, 0));
    }

    line.totalDeductions = round2(
      line.latePenalty + line.absentPenalty + line.halfDayDeduction + line.deductionTotal + line.socialSecurity + line.withholdingTax,
    );
    line.netPay = round2(line.grossEarnings - line.totalDeductions);
    return line;
  });
}
