import type { PayrollSummary, AttendanceRecord } from "@/modules/attendance/types";
import {
  DEDUCTION_TYPES,
  type EmployeeProfile,
  type PayrollAdjustment,
  type StoreHrSettings,
} from "./types";

export interface PayrollLine {
  userId: string;
  employeeName: string;
  payType: EmployeeProfile["payType"];
  totalDays: number;
  totalHours: number;
  /** Base pay from the wage profile before adjustments. */
  basePay: number;
  /** Auto overtime pay (hours over the daily threshold × multiplier × hourly rate). */
  otHours: number;
  otPay: number;
  /** Auto late penalty (minutes late × per-minute rate, capped per day). */
  latePenalty: number;
  /** Auto absent penalty (scheduled working days with no record × per-day rate). */
  absentDays: number;
  absentPenalty: number;
  /** Sum of manual bonus adjustments. */
  bonusTotal: number;
  /** Sum of manual deduction adjustments (penalty/leave/absent/late), as a positive number. */
  deductionTotal: number;
  /** basePay + otPay + bonusTotal − latePenalty − absentPenalty − deductionTotal. */
  netPay: number;
  adjustments: PayrollAdjustment[];
  hasProfile: boolean;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Effective hourly rate for OT, derived from whichever wage basis the employee uses. */
export function effectiveHourlyRate(profile: EmployeeProfile, regularHoursPerDay: number): number {
  if (profile.hourlyRate > 0) return profile.hourlyRate;
  if (profile.dailyRate > 0 && regularHoursPerDay > 0) return profile.dailyRate / regularHoursPerDay;
  if (profile.monthlySalary > 0 && regularHoursPerDay > 0) {
    return profile.monthlySalary / (30 * regularHoursPerDay);
  }
  return 0;
}

/** Base pay implied by the wage profile for a period's attendance totals. */
export function computeBasePay(profile: EmployeeProfile | undefined, summary: PayrollSummary): number {
  if (!profile) return 0;
  switch (profile.payType) {
    case "monthly":
      return round2(profile.monthlySalary);
    case "daily":
      return round2(profile.dailyRate * summary.totalDays);
    case "hourly":
      return round2(profile.hourlyRate * summary.totalHours);
    default:
      return 0;
  }
}

/** Local "HH:MM" minutes-of-day for an ISO timestamp in the given IANA timezone. */
function localMinutesOfDay(iso: string, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

function expectedStartMinutes(time: string): number | null {
  const m = /^(\d{2}):(\d{2})/.exec(time);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Iterate YYYY-MM-DD dates inclusive. */
function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
}

function periodDayCount(from: string, to: string): number {
  return eachDate(from, to).length;
}

function autoAbsentPenaltyPerDay(
  profile: EmployeeProfile,
  settings: StoreHrSettings,
  periodStart: string,
  periodEnd: string,
): number {
  if (settings.absentPenaltyPerDay <= 0) return 0;
  if (profile.payType === "monthly" && profile.monthlySalary > 0) {
    const days = periodDayCount(periodStart, periodEnd);
    return days > 0 ? profile.monthlySalary / days : 0;
  }
  return settings.absentPenaltyPerDay;
}

export interface PayrollComputeInput {
  summaries: PayrollSummary[];
  records: AttendanceRecord[];
  profiles: EmployeeProfile[];
  adjustments: PayrollAdjustment[];
  settings: StoreHrSettings;
  holidayDates?: Iterable<string>;
  periodStart: string;
  periodEnd: string;
  /** Store-local "today"; absent days are only counted up to this date. */
  today: string;
  timezone: string;
}

/**
 * Merge attendance with wage profiles, store policy and manual adjustments into payroll lines.
 * Auto-computes overtime pay, late penalties and absent penalties from the attendance records.
 */
export function computePayrollLines(input: PayrollComputeInput): PayrollLine[] {
  const { summaries, records, profiles, adjustments, settings, holidayDates = [], periodStart, periodEnd, today, timezone } = input;

  const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
  const summaryByUser = new Map(summaries.map((s) => [s.userId, s]));
  const holidayDateSet = new Set(holidayDates);

  const recordsByUser = new Map<string, AttendanceRecord[]>();
  for (const r of records) {
    const next = recordsByUser.get(r.userId) ?? [];
    next.push(r);
    recordsByUser.set(r.userId, next);
  }

  const adjByUser = new Map<string, PayrollAdjustment[]>();
  for (const a of adjustments) {
    const next = adjByUser.get(a.userId) ?? [];
    next.push(a);
    adjByUser.set(a.userId, next);
  }

  const absentScanEnd = periodEnd < today ? periodEnd : today;

  const userIds = new Set<string>([
    ...summaries.map((s) => s.userId),
    ...adjustments.map((a) => a.userId),
    ...records.map((r) => r.userId),
    ...profiles.map((p) => p.userId),
  ]);

  const lines: PayrollLine[] = [];
  for (const userId of userIds) {
    const summary = summaryByUser.get(userId);
    const profile = profileByUser.get(userId);
    const userRecords = recordsByUser.get(userId) ?? [];
    const userAdj = adjByUser.get(userId) ?? [];

    const employeeName =
      summary?.employeeName ?? userRecords[0]?.employeeName ?? userAdj[0]?.employeeName ?? profile?.displayName ?? userId;
    const totalDays = summary?.totalDays ?? 0;
    const totalHours = summary?.totalHours ?? 0;

    const basePay = summary
      ? computeBasePay(profile, summary)
      : profile && profile.payType === "monthly"
        ? round2(profile.monthlySalary)
        : 0;

    // --- Auto OT + late from records (grouped by store-local day) ---
    let otHours = 0;
    let latePenalty = 0;
    if (profile) {
      const hoursByDay = new Map<string, number>();
      const startMin = profile.expectedStartTime ? expectedStartMinutes(profile.expectedStartTime) : null;
      const seenLateDays = new Set<string>();
      for (const r of userRecords) {
        if (r.clockOutAt) {
          const ms = new Date(r.clockOutAt).getTime() - new Date(r.clockInAt).getTime();
          if (ms > 0) hoursByDay.set(r.date, (hoursByDay.get(r.date) ?? 0) + ms / 3_600_000);
        }
        // Late penalty: once per day, based on first clock-in vs expected start + grace.
        if (startMin !== null && settings.latePenaltyPerMinute > 0 && !seenLateDays.has(r.date)) {
          const inMin = localMinutesOfDay(r.clockInAt, timezone);
          const lateBy = inMin - (startMin + profile.lateGraceMinutes);
          if (lateBy > 0) {
            const raw = lateBy * settings.latePenaltyPerMinute;
            const capped = settings.latePenaltyMaxPerDay > 0 ? Math.min(raw, settings.latePenaltyMaxPerDay) : raw;
            latePenalty += capped;
            seenLateDays.add(r.date);
          }
        }
      }
      if (profile.otEligible && settings.otDailyCapHours > 0) {
        for (const dayHours of hoursByDay.values()) {
          const over = Math.max(0, dayHours - settings.regularHoursPerDay);
          otHours += Math.min(over, settings.otDailyCapHours);
        }
      }
    }
    otHours = round2(otHours);
    const hourly = profile ? effectiveHourlyRate(profile, settings.regularHoursPerDay) : 0;
    const otPay = round2(otHours * settings.otMultiplier * hourly);
    latePenalty = round2(latePenalty);

    // --- Auto absent: scheduled working days (per profile) with no record, up to today ---
    let absentDays = 0;
    const absentPenaltyPerDay = profile ? autoAbsentPenaltyPerDay(profile, settings, periodStart, periodEnd) : 0;
    if (profile && absentPenaltyPerDay > 0 && profile.workingDays.length > 0 && periodStart <= absentScanEnd) {
      const datesWithRecord = new Set(userRecords.map((r) => r.date));
      const leaveDates = new Set(userAdj.filter((a) => a.type === "leave").map((a) => a.date));
      for (const date of eachDate(periodStart, absentScanEnd)) {
        if (
          profile.workingDays.includes(weekdayOf(date)) &&
          !datesWithRecord.has(date) &&
          !leaveDates.has(date) &&
          !holidayDateSet.has(date)
        ) {
          absentDays += 1;
        }
      }
    }
    const absentPenalty = round2(absentDays * absentPenaltyPerDay);

    // --- Manual adjustments ---
    let bonusTotal = 0;
    let deductionTotal = 0;
    for (const a of userAdj) {
      if (DEDUCTION_TYPES.includes(a.type)) deductionTotal += a.amount;
      else bonusTotal += a.amount;
    }
    bonusTotal = round2(bonusTotal);
    deductionTotal = round2(deductionTotal);

    lines.push({
      userId,
      employeeName,
      payType: profile?.payType ?? "monthly",
      totalDays,
      totalHours,
      basePay,
      otHours,
      otPay,
      latePenalty,
      absentDays,
      absentPenalty,
      bonusTotal,
      deductionTotal,
      netPay: round2(basePay + otPay + bonusTotal - latePenalty - absentPenalty - deductionTotal),
      adjustments: userAdj.sort((a, b) => b.date.localeCompare(a.date)),
      hasProfile: !!profile,
    });
  }

  return lines.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}
