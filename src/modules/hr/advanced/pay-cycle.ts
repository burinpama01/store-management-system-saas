/**
 * รอบเงินเดือนระดับร้าน (R14–R16, R22): เริ่มวันที่ N ของเดือน — 24 → 24 ต.ค.–23 พ.ย.
 * วันจ่ายแยกจากรอบ: เลข 1–31 (ปัดเป็นวันสุดท้ายถ้าเดือนนั้นสั้นกว่า) หรือ 0 = วันสุดท้ายของเดือน
 * วันที่ทั้งหมดเป็น "YYYY-MM-DD" ตามเวลาสาขา
 */

export interface PayPeriod {
  start: string;
  end: string;
  payDate: string;
}

function ymd(y: number, m: number, d: number): string {
  // m เป็น 1-based และอาจล้นปี — ปล่อยให้ Date.UTC จัดการ
  return new Date(Date.UTC(y, m - 1, d, 12)).toISOString().slice(0, 10);
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return ymd(y, m, d + days);
}

/** วันจ่ายของงวดที่จบวันที่ periodEnd — อยู่ในเดือนเดียวกับวันจบงวด ถ้าตกก่อนวันจบงวดให้เลื่อนไปเดือนถัดไป */
export function payDateFor(periodEnd: string, payDay: number): string {
  const [y, m] = parts(periodEnd);
  const pick = (yy: number, mm: number) => {
    const last = lastDayOfMonth(yy, mm);
    const day = payDay <= 0 ? last : Math.min(payDay, last);
    return ymd(yy, mm, day);
  };
  const sameMonth = pick(y, m);
  if (sameMonth >= periodEnd) return sameMonth;
  return pick(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
}

/** งวดที่มีวันที่ date อยู่ */
export function periodContaining(date: string, startDay: number, payDay: number): PayPeriod {
  const sd = Math.min(28, Math.max(1, Math.round(startDay)));
  const [y, m, d] = parts(date);
  const start = d >= sd ? ymd(y, m, sd) : ymd(y, m - 1, sd);
  const [sy, smo] = parts(start);
  const end = ymd(sy, smo + 1, sd - 1);
  return { start, end, payDate: payDateFor(end, payDay) };
}

/** งวดก่อนหน้า */
export function previousPeriod(period: PayPeriod, startDay: number, payDay: number): PayPeriod {
  return periodContaining(addDays(period.start, -1), startDay, payDay);
}

/** งวดล่าสุด n งวด (ใหม่ → เก่า) รวมงวดปัจจุบัน — ใช้ทำ dropdown */
export function recentPeriods(today: string, startDay: number, payDay: number, count: number): PayPeriod[] {
  const out: PayPeriod[] = [];
  let p = periodContaining(today, startDay, payDay);
  for (let i = 0; i < count; i += 1) {
    out.push(p);
    p = previousPeriod(p, startDay, payDay);
  }
  return out;
}

/**
 * "วันทำการ" ของเวลาหนึ่งตามเวลาปิดร้าน (R4): ปิดก่อนเที่ยง (เช่น 02:00) = ช่วงหลังเที่ยงคืนถึงเวลาปิด
 * ยังเป็นของเมื่อวาน; ไม่ตั้ง/ปิดหลังเที่ยง = ตัด 00:00 ตามปกติ
 */
export function businessDate(now: Date, timeZone: string, closingTime?: string | null): string {
  const offsetMinutes = closingOffsetMinutes(closingTime);
  const shifted = new Date(now.getTime() - offsetMinutes * 60_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
}

export function closingOffsetMinutes(closingTime?: string | null): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(closingTime ?? "");
  if (!match) return 0;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < 12 * 60 ? minutes : 0;
}

/** งวดที่ควรปิดแล้ว ณ ตอนนี้: วันทำการปัจจุบันเลยวันจบงวดไปแล้ว (= หลังเวลาปิดร้านของวันสุดท้าย) */
export function isPeriodDue(period: PayPeriod, currentBusinessDate: string): boolean {
  return currentBusinessDate > period.end;
}

export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}
