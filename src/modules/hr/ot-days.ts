/**
 * กฎของ "วันให้ OT" (โหมด OT เฉพาะวัน) — แยกเป็นฟังก์ชันล้วนเพื่อให้เทสต์ได้
 *   - ย้อนหลังได้ไม่เกิน OT_DAY_BACKDATE_LIMIT_DAYS วัน (นับจากวันนี้ตามเวลาร้าน)
 *   - วันที่อยู่ในงวดที่ปิด/จ่ายเงินแล้ว (หรือสัปดาห์ที่บันทึกยอดจ่ายรายสัปดาห์ของคนในรายชื่อแล้ว) เพิ่ม/แก้/ลบไม่ได้
 * server action ต้องเรียก validate + lock ทุกครั้ง — หน้าจอกันไว้ก่อนเฉย ๆ เชื่อไม่ได้
 */
import { OT_DAY_BACKDATE_LIMIT_DAYS } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** เพิ่มเป็นช่วงได้ครั้งละไม่เกินกี่วัน (กันกดผิดสร้างทั้งปี) */
export const OT_DAY_MAX_RANGE_DAYS = 62;
/** กำหนดล่วงหน้าได้ไกลสุดกี่วัน */
export const OT_DAY_MAX_AHEAD_DAYS = 366;

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** วันแรกที่ยังให้ OT ย้อนหลังได้ */
export function earliestOtDayDate(today: string): string {
  return addDaysIso(today, -OT_DAY_BACKDATE_LIMIT_DAYS);
}

export interface OtDayDraft {
  dates: string[];
  capHours: number;
  multiplier: number | null;
  userIds: string[];
  note?: string;
}

export type OtDayValidation = { ok: true; draft: OtDayDraft } | { ok: false; error: string };

/** ตรวจค่าจากฟอร์ม + ขยายช่วงวันเป็นรายวัน */
export function validateOtDayInput(input: {
  from: string;
  to: string;
  capHours: number;
  multiplier: number | null;
  userIds: string[];
  note?: string;
  today: string;
  /** รายชื่อพนักงานของสาขา — userIds ต้องอยู่ในนี้ทั้งหมด */
  rosterUserIds: Set<string>;
}): OtDayValidation {
  const { from, today } = input;
  const to = input.to || from;
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) return { ok: false, error: "วันที่ไม่ถูกต้อง" };
  if (to < from) return { ok: false, error: "วันสิ้นสุดต้องไม่ก่อนวันเริ่ม" };
  const earliest = earliestOtDayDate(today);
  if (from < earliest) {
    return { ok: false, error: `ให้ OT ย้อนหลังได้ไม่เกิน ${OT_DAY_BACKDATE_LIMIT_DAYS} วัน (ตั้งแต่ ${earliest})` };
  }
  if (to > addDaysIso(today, OT_DAY_MAX_AHEAD_DAYS)) return { ok: false, error: "กำหนดล่วงหน้าได้ไม่เกิน 1 ปี" };
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) {
    dates.push(d);
    if (dates.length > OT_DAY_MAX_RANGE_DAYS) return { ok: false, error: `เพิ่มได้ครั้งละไม่เกิน ${OT_DAY_MAX_RANGE_DAYS} วัน` };
  }
  if (!Number.isFinite(input.capHours) || input.capHours <= 0 || input.capHours > 12) {
    return { ok: false, error: "OT สูงสุดต้องมากกว่า 0 และไม่เกิน 12 ชม." };
  }
  const capHours = Math.round(input.capHours * 100) / 100;
  let multiplier: number | null = null;
  if (input.multiplier != null) {
    if (!Number.isFinite(input.multiplier) || input.multiplier < 1 || input.multiplier > 5) {
      return { ok: false, error: "ตัวคูณต้องอยู่ระหว่าง 1–5" };
    }
    multiplier = Math.round(input.multiplier * 100) / 100;
  }
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return { ok: false, error: "เลือกพนักงานที่ได้ OT อย่างน้อย 1 คน" };
  if (userIds.some((id) => !input.rosterUserIds.has(id))) return { ok: false, error: "มีพนักงานที่ไม่ได้อยู่ในสาขานี้" };
  const note = input.note?.replace(/\s+/g, " ").trim().slice(0, 120) || undefined;
  return { ok: true, draft: { dates, capHours, multiplier, userIds, note } };
}

export interface PaidPeriod {
  periodStart: string;
  periodEnd: string;
  status: "closed" | "reopened";
}

export interface PaidWeek {
  userId: string;
  weekStart: string;
  weekEnd: string;
}

/**
 * วันแรกที่ติดล็อก "จ่ายเงินแล้ว" (null = ไม่ติด)
 *   งวดรายเดือนที่สถานะ closed (reopened = เปิดแก้อยู่ ยังแก้ได้) · สัปดาห์ที่บันทึกยอดรายสัปดาห์ของคนในรายชื่อแล้ว
 */
export function findPaidLock(
  dates: string[],
  userIds: string[],
  periods: PaidPeriod[],
  weeks: PaidWeek[],
): { date: string; reason: string } | null {
  const users = new Set(userIds);
  for (const date of [...dates].sort()) {
    const period = periods.find((p) => p.status === "closed" && p.periodStart <= date && date <= p.periodEnd);
    if (period) return { date, reason: `งวด ${period.periodStart} ถึง ${period.periodEnd} ปิดและจ่ายเงินแล้ว ให้ OT เพิ่มไม่ได้` };
    const week = weeks.find((w) => users.has(w.userId) && w.weekStart <= date && date <= w.weekEnd);
    if (week) return { date, reason: `สัปดาห์ ${week.weekStart} ถึง ${week.weekEnd} บันทึกยอดจ่ายรายสัปดาห์แล้ว ให้ OT เพิ่มไม่ได้` };
  }
  return null;
}

/** ป้ายวันให้ OT บนปฏิทินลงเวลา (ส่งให้ client เฉพาะข้อมูลที่ต้องแสดง) */
export interface CalendarOtDay {
  date: string;
  capHours: number;
  multiplier: number | null;
  /** พนักงานที่ได้ OT วันนั้น — ปฏิทินส่วนตัวส่งมาแค่ตัวเอง */
  userIds: string[];
  note: string | null;
}

/**
 * แปลงวันให้ OT เป็นข้อมูลปฏิทิน
 *   - viewerUserId = ปฏิทินส่วนตัว: เหลือเฉพาะวันที่คนนี้อยู่ในรายชื่อ และไม่ส่งรายชื่อคนอื่นออกไป
 *   - ไม่ส่ง = ปฏิทินทีม (ผู้จัดการ): ส่งครบทุกวันพร้อมรายชื่อ
 */
export function toCalendarOtDays(
  days: { date: string; capHours: number; multiplier: number | null; userIds: string[]; note?: string | null }[],
  viewerUserId?: string,
): CalendarOtDay[] {
  return days
    .filter((d) => !viewerUserId || d.userIds.includes(viewerUserId))
    .map((d) => ({
      date: d.date,
      capHours: d.capHours,
      multiplier: d.multiplier,
      userIds: viewerUserId ? [viewerUserId] : [...d.userIds],
      note: d.note ?? null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
