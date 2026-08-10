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

/**
 * Scheduled working days inside the pay period — the divisor for pro-rating a monthly salary.
 * The period is whatever range payroll is run for, not a calendar month: a store paying from the
 * 6th runs 6 ม.ค.–5 ก.พ., then 6 ก.พ.–5 มี.ค., and each window is its own full month of salary.
 */
function scheduledDaysInPeriod(periodStart: string, periodEnd: string, workingDays: number[]): number {
  let count = 0;
  for (const date of eachDate(periodStart, periodEnd)) {
    if (workingDays.includes(weekdayOf(date))) count += 1;
  }
  return count;
}

/**
 * What a single absent day costs.
 * The employee's own "ค่าปรับขาดงาน/วัน" wins when set; otherwise monthly staff are pro-rated
 * from their salary (เงินเดือน ÷ วันทำงานในงวด) so pay drops only by the days they did not
 * work — store holidays and approved leave never reach here. Other pay types fall back to the
 * store-wide rate.
 */
function absentPenaltyPerDay(
  profile: EmployeeProfile,
  settings: StoreHrSettings,
  scheduledDays: number,
): number {
  if (profile.absentPenaltyAmount > 0) return profile.absentPenaltyAmount;
  if (profile.payType === "monthly" && profile.monthlySalary > 0) {
    return scheduledDays > 0 ? profile.monthlySalary / scheduledDays : 0;
  }
  return settings.absentPenaltyPerDay;
}

/** What one late day costs: the employee's flat per-day fine, else the store's per-minute rate. */
function latePenaltyForMinutes(
  profile: EmployeeProfile,
  settings: StoreHrSettings,
  lateMinutes: number,
): number {
  if (profile.latePenaltyAmount > 0) return profile.latePenaltyAmount;
  const raw = lateMinutes * settings.latePenaltyPerMinute;
  return settings.latePenaltyMaxPerDay > 0 ? Math.min(raw, settings.latePenaltyMaxPerDay) : raw;
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
      const firstClockInByDay = new Map<string, string>();
      const startMin = profile.expectedStartTime ? expectedStartMinutes(profile.expectedStartTime) : null;
      for (const r of userRecords) {
        if (r.clockOutAt) {
          const ms = new Date(r.clockOutAt).getTime() - new Date(r.clockInAt).getTime();
          if (ms > 0) hoursByDay.set(r.date, (hoursByDay.get(r.date) ?? 0) + ms / 3_600_000);
        }
        // Records arrive newest-first, so keep the earliest punch explicitly: a split shift must
        // be judged by the morning clock-in, not by the one after the lunch break.
        const seen = firstClockInByDay.get(r.date);
        if (!seen || Date.parse(r.clockInAt) < Date.parse(seen)) {
          firstClockInByDay.set(r.date, r.clockInAt);
        }
      }
      // Late penalty: once per day, first clock-in vs expected start + grace.
      if (startMin !== null && (settings.latePenaltyPerMinute > 0 || profile.latePenaltyAmount > 0)) {
        for (const clockInAt of firstClockInByDay.values()) {
          const lateBy = localMinutesOfDay(clockInAt, timezone) - (startMin + profile.lateGraceMinutes);
          if (lateBy > 0) latePenalty += latePenaltyForMinutes(profile, settings, lateBy);
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
    let perAbsentDay = 0;
    if (profile && profile.workingDays.length > 0 && periodStart <= absentScanEnd) {
      // Divisor spans the whole period even though absences are only scanned up to today —
      // a mid-period payroll preview must not inflate what each missed day costs.
      const scheduledDays = scheduledDaysInPeriod(periodStart, periodEnd, profile.workingDays);
      perAbsentDay = absentPenaltyPerDay(profile, settings, scheduledDays);
      // A shift counts as worked only once it is closed. Clocking in and never clocking out
      // breaks the rule the employee is responsible for, so payroll scores it as absence —
      // except for today, where the shift may still legitimately be open.
      const attendedDates = new Set(
        userRecords.filter((r) => r.clockOutAt || r.date === today).map((r) => r.date),
      );
      const leaveDates = new Set(userAdj.filter((a) => a.type === "leave").map((a) => a.date));
      for (const date of eachDate(periodStart, absentScanEnd)) {
        if (
          profile.workingDays.includes(weekdayOf(date)) &&
          !attendedDates.has(date) &&
          !leaveDates.has(date) &&
          !holidayDateSet.has(date)
        ) {
          absentDays += 1;
        }
      }
    }
    const absentPenalty = round2(absentDays * perAbsentDay);

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
