import type { AttendanceRecord } from "./types";

export type DayStatus =
  | "completed" // ครบ (เข้า-ออก ตรงเวลา)
  | "late" // มาสาย
  | "in_no_out" // ลงเข้าแต่ไม่ลงออก
  | "leave" // ลา
  | "absent" // ขาดงาน
  | "holiday" // วันหยุด
  | "off"; // วันหยุดประจำ/อนาคต (ไม่มาร์ก)

export interface DayStatusInput {
  month: string; // "YYYY-MM"
  today: string; // store-local "YYYY-MM-DD"
  timezone: string;
  records: AttendanceRecord[]; // one employee's records
  /** Scheduling for late/absent detection (per employee). */
  profile?: {
    expectedStartTime?: string; // "HH:MM[:SS]"
    lateGraceMinutes: number;
    workingDays: number[]; // 0=Sun..6=Sat
  } | null;
  holidays: Set<string>; // YYYY-MM-DD
  leaveDates: Set<string>; // YYYY-MM-DD (from payroll leave adjustments)
}

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
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Per-day attendance status for one employee across a month (for the calendar). */
export function computeDayStatuses(input: DayStatusInput): Map<string, DayStatus> {
  const { month, today, timezone, records, profile, holidays, leaveDates } = input;
  const workingDays = profile?.workingDays ?? [1, 2, 3, 4, 5];
  const startMin = profile?.expectedStartTime ? expectedStartMinutes(profile.expectedStartTime) : null;
  const grace = profile?.lateGraceMinutes ?? 0;

  const recsByDate = new Map<string, AttendanceRecord[]>();
  for (const r of records) {
    if (!r.date.startsWith(month)) continue;
    const next = recsByDate.get(r.date) ?? [];
    next.push(r);
    recsByDate.set(r.date, next);
  }

  const [year, mon] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const out = new Map<string, DayStatus>();

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const dayRecs = recsByDate.get(date);

    if (dayRecs && dayRecs.length > 0) {
      // Worked this day (even if it's a holiday) → reflect the actual attendance.
      const hasOpen = dayRecs.some((r) => !r.clockOutAt);
      if (hasOpen) {
        out.set(date, "in_no_out");
      } else if (startMin !== null) {
        const earliestIn = Math.min(...dayRecs.map((r) => localMinutesOfDay(r.clockInAt, timezone)));
        out.set(date, earliestIn > startMin + grace ? "late" : "completed");
      } else {
        out.set(date, "completed");
      }
      continue;
    }

    if (holidays.has(date)) {
      out.set(date, "holiday");
      continue;
    }
    if (leaveDates.has(date)) {
      out.set(date, "leave");
      continue;
    }
    // Absent only on scheduled working days that have already passed.
    if (date <= today && workingDays.includes(weekdayOf(date))) {
      out.set(date, "absent");
      continue;
    }
    out.set(date, "off");
  }

  return out;
}
