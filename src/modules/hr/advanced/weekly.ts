/**
 * จ่ายค่าแรงรายสัปดาห์ (Plan/Weekly Pay Plan v1.html · W1–W9)
 *   คิดเฉพาะวันที่มาทำงาน: เต็มวัน 1 · ครึ่งวัน 0.5 · ขาด/ลา/วันหยุด = 0 (ไม่มีค่าปรับขาดงาน)
 *   + OT + โบนัสยอดขายรายวัน (คิดทั้งร้านพร้อมกันจาก computeAdvancedPayrollLines ช่วงสัปดาห์)
 *   แยกรอบ (weekly): รวมรายการบวก/หักที่บันทึกด้วยมือในสัปดาห์ด้วย เพราะไม่มีงวดรายเดือนให้ไปลง
 *   ล่วงหน้า (weekly_advance): ไม่รวมรายการมือ — งวดรายเดือนคิดตามปกติแล้วหักยอดที่จ่ายไปแล้ว
 * pure function ทั้งหมด — ไม่แตะฐานข้อมูล
 */
import type { EmployeeProfile, StoreHrSettings } from "../types";
import type { AdvancedPayrollLine } from "./compute";
import { addDays, periodContaining } from "./pay-cycle";
import { allocateAdvanceDeduction, type AdvanceDue } from "./salary-advance";

export type PayFrequency = "monthly" | "weekly" | "weekly_advance";
export const PAY_FREQUENCIES: PayFrequency[] = ["monthly", "weekly", "weekly_advance"];
export const PAY_FREQUENCY_LABEL: Record<PayFrequency, string> = {
  monthly: "รายเดือน (ตามงวด)",
  weekly: "รายสัปดาห์ (แยกรอบ)",
  weekly_advance: "รายสัปดาห์ (จ่ายล่วงหน้า หักสิ้นงวด)",
};

export type WeeklyRateBasis = "profile" | "working_days";
export const WEEKLY_RATE_BASES: WeeklyRateBasis[] = ["profile", "working_days"];

export const WEEKDAY_FULL_LABELS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export function parsePayFrequency(v: unknown): PayFrequency {
  return v === "weekly" || v === "weekly_advance" ? v : "monthly";
}

export function isWeeklyFrequency(f: PayFrequency | undefined): f is "weekly" | "weekly_advance" {
  return f === "weekly" || f === "weekly_advance";
}

export interface PayWeek {
  start: string;
  end: string;
}

function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** สัปดาห์ (7 วัน) ที่มีวันที่ date อยู่ เริ่มวัน startDay (0 = อาทิตย์ … 6 = เสาร์) */
export function weekContaining(date: string, startDay: number): PayWeek {
  const sd = Number.isInteger(startDay) && startDay >= 0 && startDay <= 6 ? startDay : 1;
  const back = (weekday(date) - sd + 7) % 7;
  const start = addDays(date, -back);
  return { start, end: addDays(start, 6) };
}

export function previousWeek(week: PayWeek): PayWeek {
  return { start: addDays(week.start, -7), end: addDays(week.start, -1) };
}

/** สัปดาห์ล่าสุด n สัปดาห์ (ใหม่ → เก่า) รวมสัปดาห์ปัจจุบัน */
export function recentWeeks(today: string, startDay: number, count: number): PayWeek[] {
  const out: PayWeek[] = [];
  let w = weekContaining(today, startDay);
  for (let i = 0; i < count; i += 1) {
    out.push(w);
    w = previousWeek(w);
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * ค่าแรงต่อวันของพนักงานเงินเดือน
 *   profile: เรทรายวันในโปรไฟล์ (ถ้าตั้ง) ไม่ตั้ง = เงินเดือน ÷ 30
 *   working_days: เงินเดือน ÷ วันทำงานตามตารางในงวดเดือนที่วันนั้นอยู่ (ตารางของคน ว่าง = ของร้าน)
 */
export function monthlyDailyRate(
  profile: Pick<EmployeeProfile, "monthlySalary" | "dailyRate" | "workingDays">,
  date: string,
  opts: { basis: WeeklyRateBasis; storeWorkingDays: number[]; payCycleStartDay: number; payDay: number },
): number {
  if (opts.basis === "profile") {
    if (profile.dailyRate > 0) return profile.dailyRate;
    return profile.monthlySalary > 0 ? profile.monthlySalary / 30 : 0;
  }
  if (!(profile.monthlySalary > 0)) return 0;
  const working = profile.workingDays.length > 0 ? profile.workingDays : opts.storeWorkingDays;
  const period = periodContaining(date, opts.payCycleStartDay, opts.payDay);
  const scheduled = eachDate(period.start, period.end).filter((d) => working.includes(weekday(d))).length;
  return scheduled > 0 ? profile.monthlySalary / scheduled : profile.monthlySalary / 30;
}

export interface WeeklyPayoutDay {
  date: string;
  status: string;
  /** 1 = เต็มวัน · 0.5 = ครึ่งวัน · 0 = ไม่คิดเงิน */
  units: number;
  pay: number;
}

export interface WeeklyPayout {
  userId: string;
  employeeName: string;
  mode: "weekly" | "weekly_advance";
  weekStart: string;
  weekEnd: string;
  fullDays: number;
  halfDays: number;
  /** fullDays + 0.5 × halfDays */
  workedDays: number;
  basePay: number;
  otHours: number;
  otPay: number;
  salesBonus: number;
  /** แยกรอบ: โบนัสมือ − รายการหักมือในสัปดาห์ · ล่วงหน้า = 0 */
  adjustmentsNet: number;
  /** หักเบิกล่วงหน้า (แบบแยกรอบ) */
  salaryAdvanceDeduction: number;
  salaryAdvanceItems: { id: string; paidDate: string; amount: number }[];
  /** เบิกที่หักไม่หมดในสัปดาห์นี้ (ยกไปสัปดาห์ถัดไป) */
  salaryAdvanceShortfall: number;
  amount: number;
  days: WeeklyPayoutDay[];
}

export interface WorkedDayPay {
  days: WeeklyPayoutDay[];
  fullDays: number;
  halfDays: number;
  workedDays: number;
  basePay: number;
}

/**
 * ค่าแรงจากวันที่มาทำงานจริงในช่วง from–to (เต็มวัน 1 · ครึ่งวัน 0.5 · ขาด/ลา/วันหยุด 0) — ไม่รวม OT/โบนัส
 * ใช้ร่วมกัน: จ่ายรายสัปดาห์ และเพดานเบิกเงิน
 */
export function workedDayPay(
  line: Pick<AdvancedPayrollLine, "days" | "basePay">,
  profile: Pick<EmployeeProfile, "payType" | "monthlySalary" | "dailyRate" | "workingDays">,
  from: string,
  to: string,
  opts: { rateBasis: WeeklyRateBasis; storeWorkingDays: number[]; payCycleStartDay: number; payDay: number },
): WorkedDayPay {
  const input = { hrSettings: { workingDays: opts.storeWorkingDays }, rateBasis: opts.rateBasis, payCycleStartDay: opts.payCycleStartDay, payDay: opts.payDay };
    const days: WeeklyPayoutDay[] = line.days
      .filter((d) => d.date >= from && d.date <= to)
      .map((d) => ({ date: d.date, status: d.status, units: d.status === "full" ? 1 : d.status === "half" ? 0.5 : 0, pay: 0 }));
    const fullDays = days.filter((d) => d.units === 1).length;
    const halfDays = days.filter((d) => d.units === 0.5).length;
    const workedDays = fullDays + 0.5 * halfDays;

    let basePay: number;
    if (profile.payType === "monthly") {
      basePay = 0;
      for (const d of days) {
        if (!d.units) continue;
        const rate = monthlyDailyRate(profile, d.date, {
          basis: input.rateBasis,
          storeWorkingDays: input.hrSettings.workingDays,
          payCycleStartDay: input.payCycleStartDay,
          payDay: input.payDay,
        });
        d.pay = round2(rate * d.units);
        basePay += rate * d.units;
      }
      basePay = round2(basePay);
    } else {
      // รายวัน/รายชั่วโมง: ค่าแรงพื้นฐานของบรรทัดคิดเฉพาะวันที่มาอยู่แล้ว (รวมเรทกลางสัปดาห์ + ครึ่งวัน)
      basePay = round2(line.basePay);
      // ยอดรายวันในรายละเอียด = กระจาย basePay ตามสัดส่วน (รายวัน: ตามหน่วยวัน · รายชั่วโมง: ตามชั่วโมง)
      const hoursByDate = new Map(line.days.map((d) => [d.date, d.hours]));
      const weight = (d: WeeklyPayoutDay) => (!d.units ? 0 : profile.payType === "hourly" ? hoursByDate.get(d.date) ?? 0 : d.units);
      const totalWeight = days.reduce((s, d) => s + weight(d), 0);
      if (totalWeight > 0) {
        for (const d of days) d.pay = round2((basePay * weight(d)) / totalWeight);
        // เศษสตางค์จากการปัดทีละวันไปไว้วันสุดท้ายที่มา → ผลรวมรายวัน = basePay พอดี
        const last = [...days].reverse().find((d) => weight(d) > 0);
        if (last) last.pay = round2(last.pay + basePay - days.reduce((s, d) => s + d.pay, 0));
      }
    }

  return { days, fullDays, halfDays, workedDays, basePay };
}

export interface WeeklyComputeInput {
  week: PayWeek;
  /** บรรทัดเงินเดือนที่คิดทั้งร้านช่วง week.start–week.end */
  lines: AdvancedPayrollLine[];
  profiles: EmployeeProfile[];
  hrSettings: Pick<StoreHrSettings, "workingDays">;
  rateBasis: WeeklyRateBasis;
  payCycleStartDay: number;
  payDay: number;
  /** เบิกเงินที่ยังไม่ถูกหัก ต่อ userId — หักเฉพาะพนักงานแบบแยกรอบ (แบบล่วงหน้าหักในงวดรายเดือน) */
  salaryAdvances?: Map<string, AdvanceDue[]>;
}

/** ยอดรายสัปดาห์ของพนักงานที่ตั้งรอบจ่ายรายสัปดาห์ (คนอื่นไม่อยู่ในผลลัพธ์) */
export function computeWeeklyPayouts(input: WeeklyComputeInput): WeeklyPayout[] {
  const profileByUser = new Map(input.profiles.map((p) => [p.userId, p]));
  const out: WeeklyPayout[] = [];
  for (const line of input.lines) {
    const profile = profileByUser.get(line.userId);
    const mode = profile?.payFrequency;
    if (!profile || !isWeeklyFrequency(mode)) continue;
    // ลาออกก่อนสัปดาห์เริ่ม = ไม่มียอด
    if (profile.employmentEndDate && profile.employmentEndDate < input.week.start) continue;

    const { days, fullDays, halfDays, workedDays, basePay } = workedDayPay(line, profile, input.week.start, input.week.end, {
      rateBasis: input.rateBasis,
      storeWorkingDays: input.hrSettings.workingDays,
      payCycleStartDay: input.payCycleStartDay,
      payDay: input.payDay,
    });

    const adjustmentsNet = mode === "weekly" ? round2(line.bonusTotal - line.deductionTotal) : 0;
    const gross = round2(Math.max(0, basePay + line.otPay + line.salesBonus + adjustmentsNet));
    const advance =
      mode === "weekly"
        ? allocateAdvanceDeduction(input.salaryAdvances?.get(line.userId) ?? [], input.week.end, gross)
        : { total: 0, items: [], shortfall: 0 };
    const amount = round2(gross - advance.total);
    out.push({
      userId: line.userId,
      employeeName: line.employeeName,
      mode,
      weekStart: input.week.start,
      weekEnd: input.week.end,
      fullDays,
      halfDays,
      workedDays,
      basePay,
      otHours: line.otHours,
      otPay: round2(line.otPay),
      salesBonus: round2(line.salesBonus),
      adjustmentsNet,
      salaryAdvanceDeduction: advance.total,
      salaryAdvanceItems: advance.items,
      salaryAdvanceShortfall: advance.shortfall,
      amount,
      days,
    });
  }
  return out.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}

/** cron บันทึกอัตโนมัติเฉพาะสัปดาห์ที่จบตั้งแต่วันเปิดสวิตช์ (สัปดาห์ก่อนหน้า ผู้จัดการกดเอง) */
export function isWeekAutoRecordable(week: PayWeek, enabledAt: string | null | undefined): boolean {
  return !enabledAt || week.end >= enabledAt;
}

/** ข้อความแจ้งเจ้าของ — ชื่อ + ยอด + จำนวนวัน (ห้ามมีเลขบัญชี) */
export function weeklyOwnerMessage(payouts: Pick<WeeklyPayout, "employeeName" | "amount" | "workedDays">[], fmt: (n: number) => string): string {
  const total = round2(payouts.reduce((s, p) => s + p.amount, 0));
  const each = payouts.map((p) => `${p.employeeName} ${fmt(p.amount)} (${p.workedDays} วัน)`).join(" · ");
  return `${payouts.length} คน · รวม ${fmt(total)}${each ? ` — ${each}` : ""}`;
}
