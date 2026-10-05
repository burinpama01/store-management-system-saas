// สรุปยอดจาก "เวลาปิดร้าน" — ตรรกะบริสุทธิ์ (ทดสอบแยกได้ ไม่แตะ DB)
//
// ปกติสรุปยอดส่งตอนคนสุดท้ายกดออกงาน ถ้าเลยเวลาปิดร้าน 1 ชม. แล้วยังไม่มีสรุปของวันนั้น
// (ลืมกดออก / แอดมินแก้เวลาออกให้ทีหลัง) ระบบส่งให้เอง พร้อมบอกว่าใครยังไม่กดออกงาน
// ไม่แตะข้อมูลกะ — การปิดกะเป็นเรื่องที่เจ้าของตัดสินเอง

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
