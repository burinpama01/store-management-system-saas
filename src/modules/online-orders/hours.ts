import { z } from "zod";
import { DEFAULT_TIME_ZONE, storeDateTimeToUtc } from "@/shared/utils/datetime";

/**
 * เวลารับออเดอร์ออนไลน์ — เวลาประจำสัปดาห์ + วันหยุด/เวลาพิเศษเฉพาะวัน + ปิดด่วน
 * โมดูลบริสุทธิ์ (ไม่แตะ DB) ใช้ทั้ง server (ด่านสั่ง/จ่าย) และหน้าเว็บ (แสดงสถานะ)
 *
 * กติกาเวลา: ปิด <= เปิด = ข้ามเที่ยงคืน (18:00–02:00, 09:00–00:00 = ถึงเที่ยงคืน) · เปิด = ปิด = 24 ชม.
 */

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "เวลาไม่ถูกต้อง");
const isoDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, "วันที่ไม่ถูกต้อง")
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, "วันที่ไม่มีในปฏิทิน");

export const dayHoursSchema = z.object({ closed: z.boolean(), open: hhmm, close: hhmm }).strict();
export type DayHours = z.infer<typeof dayHoursSchema>;

export const hoursExceptionSchema = z
  .object({
    date: isoDate,
    closed: z.boolean(),
    open: hhmm,
    close: hhmm,
    note: z.string().trim().max(80),
  })
  .strict();
export type HoursException = z.infer<typeof hoursExceptionSchema>;

export const MAX_HOURS_EXCEPTIONS = 60;

export const orderingHoursSchema = z
  .object({
    /** false = เปิดรับตลอด 24 ชม. (พฤติกรรมเดิม) */
    enabled: z.boolean(),
    /** index 0 = อาทิตย์ … 6 = เสาร์ */
    weekly: z.array(dayHoursSchema).length(7),
    exceptions: z.array(hoursExceptionSchema).max(MAX_HOURS_EXCEPTIONS),
  })
  .strict()
  .refine((h) => new Set(h.exceptions.map((e) => e.date)).size === h.exceptions.length, "มีวันที่ซ้ำในรายการวันพิเศษ");
export type OrderingHours = z.infer<typeof orderingHoursSchema>;

export const DAY_LABELS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"] as const;
export const DAY_SHORT = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."] as const;

export const DEFAULT_ORDERING_HOURS: OrderingHours = {
  enabled: false,
  weekly: Array.from({ length: 7 }, () => ({ closed: false, open: "09:00", close: "21:00" })),
  exceptions: [],
};

/** ปิดด่วน "จนกว่าจะกดเปิด" — เก็บเป็นวันไกลมาก (JS อ่าน 'infinity' ไม่ได้) */
export const PAUSE_INDEFINITE_ISO = "2999-12-31T00:00:00.000Z";
export const PAUSE_PRESETS = ["30m", "1h", "2h", "today", "indefinite"] as const;
export type PausePreset = (typeof PAUSE_PRESETS)[number];
export const PAUSE_PRESET_LABEL: Record<PausePreset, string> = {
  "30m": "30 นาที",
  "1h": "1 ชั่วโมง",
  "2h": "2 ชั่วโมง",
  today: "ถึงสิ้นวันนี้",
  indefinite: "จนกว่าจะกดเปิด",
};

/** แถวจาก DB (jsonb) → ค่าที่ใช้ได้ — อ่านไม่ออก = ไม่ใช้เวลาทำการ (ไม่ปิดร้านเพราะข้อมูลเสีย) */
export function parseOrderingHours(raw: unknown): OrderingHours {
  const parsed = orderingHoursSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_ORDERING_HOURS;
}

// ---------- ปฏิทินตามเขตเวลาร้าน ----------

/** "YYYY-MM-DD" ของ instant ในเขตเวลาร้าน */
export function localDateOf(instant: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || DEFAULT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function toMs(date: string, time: string, timeZone: string): number {
  const iso = storeDateTimeToUtc(`${date}T${time}`, timeZone || DEFAULT_TIME_ZONE);
  return iso ? Date.parse(iso) : NaN;
}

/** เวลาที่ใช้กับวันนั้น: รายการเฉพาะวันชนะเวลาประจำสัปดาห์ */
export function hoursForDate(hours: OrderingHours, date: string): { closed: boolean; open: string; close: string; note: string | null; special: boolean } {
  const ex = hours.exceptions.find((e) => e.date === date);
  if (ex) return { closed: ex.closed, open: ex.open, close: ex.close, note: ex.note || null, special: true };
  const w = hours.weekly[dayOfWeek(date)];
  return { closed: w.closed, open: w.open, close: w.close, note: null, special: false };
}

interface Window {
  start: number;
  end: number;
}

function windowFor(hours: OrderingHours, date: string, timeZone: string): Window | null {
  const h = hoursForDate(hours, date);
  if (h.closed) return null;
  const start = toMs(date, h.open, timeZone);
  // ปิด <= เปิด = ปิดวันถัดไป (เท่ากัน = 24 ชม.)
  const end = h.close > h.open ? toMs(date, h.close, timeZone) : toMs(addDays(date, 1), h.close, timeZone);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/** หาเวลาเปิดถัดไปล่วงหน้ากี่วัน (ปิดยาวช่วงเทศกาลก็ยังบอกวันเปิดได้) */
const LOOKAHEAD_DAYS = 60;

function windowsAround(hours: OrderingHours, fromMs: number, timeZone: string): Window[] {
  const today = localDateOf(new Date(fromMs), timeZone);
  const list: Window[] = [];
  for (let i = -1; i <= LOOKAHEAD_DAYS; i++) {
    const w = windowFor(hours, addDays(today, i), timeZone);
    if (w) list.push(w);
  }
  return list.sort((a, b) => a.start - b.start);
}

/** ช่วงที่ครอบ t (ต่อช่วงที่ชนกันให้ยาวต่อเนื่อง เช่น 24 ชม. หลายวัน) */
function openWindowAt(windows: Window[], t: number): Window | null {
  const hit = windows.find((w) => w.start <= t && t < w.end);
  if (!hit) return null;
  let end = hit.end;
  for (const w of windows) if (w.start <= end && w.end > end) end = w.end;
  return { start: hit.start, end };
}

function nextStartAtOrAfter(windows: Window[], t: number): number | null {
  const inside = windows.find((w) => w.start <= t && t < w.end);
  if (inside) return t;
  const next = windows.find((w) => w.start >= t);
  return next ? next.start : null;
}

// ---------- สถานะรับออเดอร์ ----------

export type OrderingAvailability =
  | { open: true; closesAt: string | null }
  | { open: false; reason: "paused" | "outside_hours"; message: string | null; reopensAt: string | null };

export interface OrderingSchedule {
  hours: OrderingHours;
  pausedUntil: string | null;
  pausedReason: string | null;
}

export const ALWAYS_OPEN: OrderingAvailability = { open: true, closesAt: null };

export function evaluateOrderingAvailability(schedule: OrderingSchedule, now: Date, timeZone: string): OrderingAvailability {
  const t = now.getTime();
  const { hours } = schedule;
  const pausedMs = schedule.pausedUntil ? Date.parse(schedule.pausedUntil) : NaN;
  const windows = hours.enabled ? windowsAround(hours, t, timeZone) : [];

  if (Number.isFinite(pausedMs) && pausedMs > t) {
    let reopensAt: string | null = null;
    if (schedule.pausedUntil !== PAUSE_INDEFINITE_ISO && pausedMs < Date.parse(PAUSE_INDEFINITE_ISO)) {
      if (!hours.enabled) reopensAt = new Date(pausedMs).toISOString();
      else {
        const next = nextStartAtOrAfter(windowsAround(hours, pausedMs, timeZone), pausedMs);
        reopensAt = next === null ? null : new Date(next).toISOString();
      }
    }
    return { open: false, reason: "paused", message: schedule.pausedReason?.trim() || null, reopensAt };
  }

  if (!hours.enabled) return ALWAYS_OPEN;

  const current = openWindowAt(windows, t);
  // เปิดยาวเกิน 24 ชม. (ตั้ง 24 ชม. หลายวัน) ไม่ต้องบอกเวลาปิดที่ไกลมาก
  if (current) return { open: true, closesAt: current.end - t > 24 * 3_600_000 ? null : new Date(current.end).toISOString() };

  const today = localDateOf(now, timeZone);
  const todayHours = hoursForDate(hours, today);
  const next = nextStartAtOrAfter(windows, t);
  return {
    open: false,
    reason: "outside_hours",
    message: todayHours.closed && todayHours.note ? todayHours.note : null,
    reopensAt: next === null ? null : new Date(next).toISOString(),
  };
}

/** เวลาเปิดกลับของปุ่มปิดด่วน (คิดฝั่ง server) */
export function pauseUntilFor(preset: PausePreset, schedule: OrderingSchedule, now: Date, timeZone: string): string {
  const t = now.getTime();
  switch (preset) {
    case "30m":
      return new Date(t + 30 * 60_000).toISOString();
    case "1h":
      return new Date(t + 60 * 60_000).toISOString();
    case "2h":
      return new Date(t + 120 * 60_000).toISOString();
    case "indefinite":
      return PAUSE_INDEFINITE_ISO;
    case "today": {
      // อยู่ในช่วงเปิด = ถึงเวลาปิดของรอบนี้ (รอบข้ามเที่ยงคืนก็ถึงตีสอง) · ไม่ใช้เวลาทำการ/นอกเวลา = ถึงเที่ยงคืน
      if (schedule.hours.enabled) {
        const current = openWindowAt(windowsAround(schedule.hours, t, timeZone), t);
        if (current) return new Date(current.end).toISOString();
      }
      const midnight = toMs(addDays(localDateOf(now, timeZone), 1), "00:00", timeZone);
      return new Date(Number.isFinite(midnight) ? midnight : t + 12 * 3_600_000).toISOString();
    }
  }
}

/** "วันนี้ 09:00" / "พรุ่งนี้ 09:00" / "ส. 6 ธ.ค. 09:00" */
export function formatReopenAt(iso: string, now: Date, timeZone: string): string {
  const d = new Date(iso);
  const tz = timeZone || DEFAULT_TIME_ZONE;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const date = localDateOf(d, tz);
  const today = localDateOf(now, tz);
  if (date === today) return `วันนี้ ${time}`;
  if (date === addDays(today, 1)) return `พรุ่งนี้ ${time}`;
  const label = new Intl.DateTimeFormat("th-TH", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
  return `${label} ${time}`;
}

/** ข้อความสถานะสั้นสำหรับลูกค้า/หลังร้าน */
export function describeAvailability(a: OrderingAvailability, now: Date, timeZone: string): { title: string; detail: string | null } {
  if (a.open) {
    return { title: "เปิดรับออเดอร์", detail: a.closesAt ? `รับออเดอร์ถึง ${formatReopenAt(a.closesAt, now, timeZone)}` : null };
  }
  const title = a.reason === "paused" ? "ร้านปิดรับออเดอร์ชั่วคราว" : "ร้านปิดรับออเดอร์ตอนนี้";
  const parts = [a.message, a.reopensAt ? `เปิดรับอีกครั้ง ${formatReopenAt(a.reopensAt, now, timeZone)}` : null].filter(Boolean);
  return { title, detail: parts.length ? parts.join(" · ") : null };
}
