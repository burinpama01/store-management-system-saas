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
  computeDailySalesBonuses,
  computeMonthlySalesBonuses,
  computeStoreSalesDays,
  fullMonthsBetween,
  hasMultipleRates,
  isPermanentOn,
  nextTier,
  rateOn,
  rateSegments,
  salesBonusEligible,
  seniorityPayFor,
  skillPayFor,
  socialSecurityFor,
  withholdingTaxPercent,
  type EmployeeSkillGrant,
  type MonthlySalesBonus,
  type PayRateEntry,
  type SalesBonusDayShare,
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
  /** ยอดจ่ายล่วงหน้ารายสัปดาห์ที่บันทึกแล้ว (สัปดาห์ที่วันจบอยู่ในงวด) — หักในงวดนี้ แม้ปิดสวิตช์ไปแล้ว (เงินจ่ายไปแล้วจริง) */
  weeklyAdvances?: Map<string, number>;
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
  salesBonusDays: SalesBonusDayShare[];
  /** โบนัสยอดขายรายเดือน (ตามรอบเงินเดือน) */
  monthlySalesBonus: number;
  monthlySalesBonusDetail: MonthlySalesBonus | null;
  socialSecurity: number;
  socialSecurityBase: number;
  withholdingTax: number;
  /** ช่วงเรทในงวดนี้ (แสดงเมื่อขึ้น/ลดเงินเดือนกลางงวด) */
  rateSegments: { from: string; to: string; days: number; label: string }[];
  grossEarnings: number;
  totalDeductions: number;
  /** เป็นพนักงานประจำ ณ วันแรกของงวด */
  permanentAtPeriodStart: boolean;
  /** หักจ่ายล่วงหน้ารายสัปดาห์ (รวมใน totalDeductions แล้ว) */
  weeklyAdvance: number;
  /** จ่ายรายสัปดาห์แบบแยกรอบ — ไม่อยู่ในงวด/สลิปรายเดือน (ปิดงวดข้ามคนนี้) */
  paidWeekly: boolean;
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
    monthlySalesBonus: 0,
    monthlySalesBonusDetail: null,
    socialSecurity: 0,
    socialSecurityBase: 0,
    withholdingTax: 0,
    rateSegments: [],
    grossEarnings: round2(line.basePay + line.otPay + line.bonusTotal),
    totalDeductions: round2(line.latePenalty + line.absentPenalty + line.halfDayDeduction + line.deductionTotal),
    permanentAtPeriodStart: false,
    weeklyAdvance: 0,
    paidWeekly: false,
  };
}

/**
 * วันเข้าร่วมร้าน (เวลาสาขา) ต่อ userId จากสมาชิกภาพ — คนเดียวมีหลายแถวใช้แถวผูกสาขาก่อนระดับองค์กร
 */
export function joinedDatesFromMembers(
  rows: { userId: string; joinedAt: string | null | undefined; storeId: string | null | undefined }[],
  timezone: string,
): Map<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const picked = new Map<string, { date: string; storeLevel: boolean }>();
  for (const r of rows) {
    if (!r.joinedAt || !Number.isFinite(Date.parse(r.joinedAt))) continue;
    const date = fmt.format(new Date(r.joinedAt));
    const storeLevel = !!r.storeId;
    const prev = picked.get(r.userId);
    if (!prev || (!prev.storeLevel && storeLevel)) picked.set(r.userId, { date, storeLevel });
  }
  return new Map([...picked].map(([id, v]) => [id, v.date]));
}

/**
 * ช่วงที่คิดเงินของพนักงานในงวด (เริ่มงาน/ลาออกกลางงวด)
 *   เริ่ม = วันที่ช้ากว่าระหว่าง "วันเริ่มงาน" กับวันเข้าร่วมร้าน — แต่ถ้ามีลงเวลาก่อนหน้านั้น เริ่มที่วันลงเวลาแรก (ทำงานจริงต้องได้เงิน)
 *   จบ = วันออกงาน
 */
export function payrollWindowFor(
  profile: Pick<EmployeeProfile, "seniorityStartDate" | "employmentEndDate">,
  joined: string | undefined,
  firstRecordDate: string | undefined,
  periodStart: string,
  periodEnd: string,
): { from: string; to: string } {
  const s = profile.seniorityStartDate;
  let start = s && joined ? (s > joined ? s : joined) : s ?? joined;
  if (start && firstRecordDate && firstRecordDate < start) start = firstRecordDate;
  const from = start && start > periodStart ? start : periodStart;
  const end = profile.employmentEndDate;
  const to = end && end < periodEnd ? end : periodEnd;
  return { from, to };
}

export function computeAdvancedPayrollLines(
  input: PayrollComputeInput,
  adv?: AdvancedComputeContext | null,
): AdvancedPayrollLine[] {
  const { periodStart, periodEnd, settings } = input;
  const periodDays = daysInclusive(periodStart, periodEnd);

  // 0) ช่วงที่คิดเงินต่อคน — เริ่มงาน/ลาออกกลางงวด = ตัดงวดเฉพาะคนนั้น (ไม่นับขาดก่อนเริ่ม/หลังออก)
  const firstRecord = new Map<string, string>();
  for (const r of input.records) {
    if (r.date < periodStart || r.date > periodEnd) continue;
    const prev = firstRecord.get(r.userId);
    if (!prev || r.date < prev) firstRecord.set(r.userId, r.date);
  }
  const windowByUser = new Map(
    input.profiles.map((p) => [
      p.userId,
      payrollWindowFor(p, input.joinedDates?.get(p.userId), firstRecord.get(p.userId), periodStart, periodEnd),
    ]),
  );

  // 1) ประวัติเรท: เรทเดียวทั้งงวด → แทนค่าในโปรไฟล์แล้วใช้สูตรเดิม; หลายเรท → คิดแยกช่วงด้านล่าง
  const multiRate = new Map<string, ReturnType<typeof rateSegments>>();
  const profiles = input.profiles.map((p) => {
    const rates = adv?.employees.get(p.userId)?.rates ?? [];
    if (rates.length === 0) return p;
    const w = windowByUser.get(p.userId);
    // ช่วงเรทตามช่วงที่คิดเงินของคนนั้น (เริ่ม/ออกกลางงวด) — ไม่งั้นฐานเงินเดือนคิดเต็มงวด
    const segs = rateSegments(rates, w && w.from <= w.to ? w.from : periodStart, w && w.from <= w.to ? w.to : periodEnd, profileRate(p));
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
  // เริ่มงานกลางงวด = คิดตั้งแต่วันเริ่มงาน (ไม่นับขาดก่อนเริ่ม · เงินเดือนคิดตามสัดส่วนวัน) · เริ่มหลังงวดจบ = ไม่มีบรรทัด
  const endedBefore = new Set(
    profiles
      .filter((p) => {
        if (p.employmentEndDate && p.employmentEndDate < periodStart) return true;
        const w = windowByUser.get(p.userId);
        return !!w && w.from > w.to;
      })
      .map((p) => p.userId),
  );
  // partialPeriod = เริ่มงานกลางงวด หรือ ออกงานกลางงวด หรือทั้งคู่
  const partialPeriod = profiles.filter((p) => {
    if (endedBefore.has(p.userId)) return false;
    const w = windowByUser.get(p.userId);
    return !!w && (w.from > periodStart || w.to < periodEnd);
  });
  const clipped = new Set(partialPeriod.map((p) => p.userId));
  const keep = <T extends { userId: string }>(rows: T[], exclude: Set<string>) => rows.filter((r) => !exclude.has(r.userId));
  const excludeMain = new Set([...endedBefore, ...clipped]);
  const baseLines = computePayrollLines({
    ...input,
    profiles: keep(profiles, excludeMain),
    summaries: keep(input.summaries, excludeMain),
    records: keep(input.records, excludeMain),
    adjustments: keep(input.adjustments, excludeMain),
  });
  for (const p of partialPeriod) {
    const { from, to } = windowByUser.get(p.userId)!;
    const inWindow = (date: string) => date >= from && date <= to;
    const only = <T extends { userId: string }>(rows: T[]) =>
      rows.filter((r) => r.userId === p.userId && (!("date" in r) || inWindow(String((r as { date?: string }).date))));
    baseLines.push(
      ...computePayrollLines({
        ...input,
        profiles: [p],
        summaries: computePayrollSummariesFor(input.summaries, p.userId, input.records.filter((r) => r.userId === p.userId && inWindow(r.date))),
        records: only(input.records),
        adjustments: only(input.adjustments),
        periodStart: from,
        periodEnd: to,
        today: input.today < to ? input.today : to,
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

  // โบนัสยอดขาย (รายวัน/รายเดือน) ต้องคิดพร้อมกันทั้งร้าน — โหมดหารต้องรู้จำนวนคนที่เข้างาน
  const selected = adv?.settings.salesBonusUserIds ?? null;
  const eligible = (userId: string, date: string) => salesBonusEligible(selected, userId, profileByUser.get(userId), date);
  const bonusEmployees = baseLines.map((l) => ({ userId: l.userId, days: l.days }));
  const dailyBonuses =
    adv && sw?.salesBonus && storeDays
      ? computeDailySalesBonuses({
          employees: bonusEmployees,
          storeDays,
          isEligibleOn: eligible,
          lateMaxMinutes: adv.settings.salesBonusLateMaxMinutes,
          mode: adv.settings.salesBonusMode,
        })
      : null;
  const monthlyBonuses =
    adv && sw?.monthlySalesBonus
      ? computeMonthlySalesBonuses({
          employees: bonusEmployees,
          // ยอดเฉพาะวันในรอบนี้ (dailySales โหลดตามช่วงงวดอยู่แล้ว)
          periodSales: [...adv.dailySales.entries()]
            .filter(([date]) => date >= periodStart && date <= periodEnd)
            .reduce((sum, [, v]) => sum + v, 0),
          tiers: adv.settings.monthlyBonusTiers,
          isEligibleOn: eligible,
          mode: adv.settings.monthlyBonusMode,
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
        // คิดเต็มงวด = สัดส่วนวันในงวด · ตัดงวด (เริ่ม/ออกกลางงวด) = ฐาน 30 วันแบบเดียวกับ monthlyBasePay
        // (เดิมใช้จำนวนวันของงวด แม้ตัดงวด → เดือน 28/31 วันไม่ตรงกับแบบเรทเดียว)
        const divisor = clipped.has(base.userId) ? 30 : periodDays;
        newBase = segs.reduce((sum, s) => sum + (s.rate.monthlySalary * s.days) / divisor, 0);
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
      const daily = dailyBonuses?.get(base.userId);
      if (daily) {
        line.salesBonus = daily.total;
        line.salesBonusDays = daily.days;
      }
      const monthly = monthlyBonuses?.get(base.userId);
      if (monthly) {
        line.monthlySalesBonus = monthly.amount;
        line.monthlySalesBonusDetail = monthly;
      }
    }

    line.grossEarnings = round2(
      line.basePay + line.otPay + line.bonusTotal + line.skillPay + line.seniorityPay + line.salesBonus + line.monthlySalesBonus,
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

    // 5) จ่ายรายสัปดาห์ (W6/W7)
    line.paidWeekly = !!sw?.weeklyPay && profile.payFrequency === "weekly";
    line.weeklyAdvance = round2(adv?.weeklyAdvances?.get(base.userId) ?? 0);

    line.totalDeductions = round2(
      line.latePenalty +
        line.absentPenalty +
        line.halfDayDeduction +
        line.deductionTotal +
        line.socialSecurity +
        line.withholdingTax +
        line.weeklyAdvance,
    );
    line.netPay = round2(line.grossEarnings - line.totalDeductions);
    return line;
  });
}
