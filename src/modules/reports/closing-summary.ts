// สรุปยอดจาก "เวลาปิดร้าน" — ตรรกะบริสุทธิ์ (ทดสอบแยกได้ ไม่แตะ DB)
//
// ปกติสรุปยอดส่งตอนคนสุดท้ายกดออกงาน ถ้าเลยเวลาปิดร้าน 1 ชม. แล้วยังไม่มีสรุปของวันนั้น
// (ลืมกดออก / แอดมินแก้เวลาออกให้ทีหลัง) ระบบส่งให้เอง พร้อมบอกว่าใครยังไม่กดออกงาน
// ไม่แตะข้อมูลกะ — การปิดกะเป็นเรื่องที่เจ้าของตัดสินเอง
//
// วันให้ OT (โหมด OT เฉพาะวัน): ถ้าคนในรายชื่อ OT ของวันนั้นยังไม่กดออกงาน ให้รอก่อน
// (สรุปตอนคน OT คนสุดท้ายออกงานจะได้ยอดครบทั้งวัน) — รอไม่เกินเพดาน OT ของวันนั้น

import { storeDateTimeToUtc } from "@/shared/utils/datetime";

/** เลยเวลาปิดไปเท่านี้ค่อยส่ง — เผื่อเวลาให้พนักงานเก็บร้านแล้วกดออกเอง (ต้องตรงกับ SQL) */
export const CLOSING_SUMMARY_GRACE_MINUTES = 60;

/**
 * รับค่าจาก input[type=time] ("HH:MM" หรือ "HH:MM:SS")
 * ว่าง = ไม่ใช้เวลาปิดร้าน (null), รูปแบบผิด = "invalid"
 */
export function parseClosingTimeInput(raw: unknown): string | null | "invalid" {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(raw.trim());
  if (!m) return "invalid";
  return `${m[1]}:${m[2]}`;
}

/** "22:00:00" จาก DB → "22:00" สำหรับแสดง/ใส่ใน input */
export function formatClosingTime(value: string | null | undefined): string {
  if (!value) return "";
  const m = /^(\d{2}):(\d{2})/.exec(value);
  return m ? `${m[1]}:${m[2]}` : "";
}

/** บรรทัดบอกที่มาของสรุป — ต่อท้ายข้อความเดียวกับสรุปตอนออกงาน */
export function buildClosingSummaryTrigger(closingTime: string, openShiftNames: readonly string[]): string {
  const at = formatClosingTime(closingTime) || closingTime;
  const head = `เลยเวลาปิดร้าน (${at} น.) มา 1 ชม.`;
  if (openShiftNames.length === 0) return `${head} · ส่งสรุปให้อัตโนมัติ`;
  const names = [...new Set(openShiftNames)];
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` และอีก ${names.length - 5} คน` : "";
  return `${head} · ยังไม่กดออกงาน: ${shown}${more}`;
}

/** รอคน OT ได้นานสุด (ชม.) — ต้องน้อยกว่าหน้าต่าง 12 ชม. ของ closing_summary_due_stores ไม่งั้นสรุปไม่ถูกส่งเลย */
export const CLOSING_SUMMARY_OT_WAIT_MAX_HOURS = 11;

/** เวลาที่ถึงกำหนดส่งสรุปจากเวลาปิดร้าน (ms) — ตรงกับ SQL: ปิดก่อน 05:00 = หลังเที่ยงคืน + 1 ชม. */
export function closingSummaryDueAtMs(date: string, closingTime: string, timezone: string): number | null {
  const hhmm = formatClosingTime(closingTime);
  if (!hhmm) return null;
  const iso = storeDateTimeToUtc(`${date}T${hhmm}`, timezone);
  if (!iso) return null;
  const base = new Date(iso).getTime();
  if (!Number.isFinite(base)) return null;
  const afterMidnight = hhmm < "05:00" ? 24 * 60 * 60 * 1000 : 0;
  return base + afterMidnight + CLOSING_SUMMARY_GRACE_MINUTES * 60 * 1000;
}

/**
 * วันให้ OT: รอส่งสรุปไหม — รอเมื่อคนในรายชื่อ OT ของวันนั้นยังไม่กดออกงาน
 * และยังไม่เลย (เวลาถึงกำหนด + เพดาน OT ของวันนั้น) — เลยแล้ว = ส่งเลย (กันลืมกดออกจนไม่มีสรุป)
 */
export function shouldWaitForOtStaff(input: {
  otDay: { capHours: number; userIds: readonly string[] } | null;
  openUserIds: readonly string[];
  dueAtMs: number | null;
  nowMs: number;
}): boolean {
  const { otDay, openUserIds, dueAtMs, nowMs } = input;
  if (!otDay || dueAtMs === null) return false;
  const listed = new Set(otDay.userIds.map((id) => id.toLowerCase()));
  if (!openUserIds.some((id) => listed.has(id.toLowerCase()))) return false;
  const waitHours = Math.min(Math.max(0, otDay.capHours), CLOSING_SUMMARY_OT_WAIT_MAX_HOURS);
  return nowMs < dueAtMs + waitHours * 60 * 60 * 1000;
}
