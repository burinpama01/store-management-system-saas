/**
 * พนักงานเบิกเงินล่วงหน้า (Plan/Employee Salary Advance Plan v2.html · B1–B8) — pure function
 *   เพดาน = ค่าแรงจากวันที่มาแล้วในรอบ × % − ยอดรายสัปดาห์ที่จ่ายแล้วในรอบ − ยอดเบิกที่ยังค้าง/รออนุมัติ
 *   หัก = ไม่เกินยอดสุทธิของงวด/สัปดาห์ เบิกเก่าก่อน ส่วนที่เหลือยกไปงวดถัดไป
 */

export type AdvanceStatus = "pending" | "paid" | "rejected" | "cancelled";

export const ADVANCE_STATUS_LABEL: Record<AdvanceStatus, string> = {
  pending: "รออนุมัติ",
  paid: "จ่ายแล้ว",
  rejected: "ไม่อนุมัติ",
  cancelled: "ยกเลิก",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AdvanceCapInput {
  /** ค่าแรงจากวันที่มาแล้วในรอบ (ฐาน + OT) */
  earned: number;
  /** % ที่ร้านให้เบิกได้ (1–100) */
  maxPercent: number;
  /** ยอดสูงสุดต่อรอบ (null = ไม่จำกัด) */
  maxAmount: number | null;
  /** จำนวนครั้งต่อรอบ (null = ไม่จำกัด) */
  maxRequests: number | null;
  /** ยอดรายสัปดาห์แบบจ่ายล่วงหน้าที่บันทึกแล้วในรอบ (เงินที่จ่ายไปแล้วสำหรับวันที่มา) */
  weeklyPaidInCycle: number;
  /** เบิกที่รออนุมัติ + จ่ายแล้วแต่ยังไม่ถูกหัก (ทุกรอบ) */
  outstanding: number;
  /** ยอดเบิก (รออนุมัติ + จ่ายแล้ว) ในรอบนี้ — ใช้กับยอดสูงสุดต่อรอบ */
  usedInCycle: number;
  /** จำนวนครั้ง (รออนุมัติ + จ่ายแล้ว) ในรอบนี้ */
  countInCycle: number;
}

export interface AdvanceCap {
  available: number;
  /** เหตุผลที่เบิกไม่ได้ (null = เบิกได้ถึง available) */
  blockedReason: string | null;
  earnedCap: number;
  /** ยอดค้าง/ครั้ง เกินเพดานแล้ว (ใช้ตรวจซ้ำหลังบันทึก — กันสองคำขอผ่านพร้อมกัน) */
  overLimit: boolean;
}

export function computeAdvanceCap(input: AdvanceCapInput): AdvanceCap {
  const pct = Math.min(100, Math.max(0, input.maxPercent)) / 100;
  const earnedCap = round2(Math.max(0, input.earned * pct - input.weeklyPaidInCycle));
  let raw = earnedCap - input.outstanding;
  if (input.maxAmount !== null) raw = Math.min(raw, input.maxAmount - input.usedInCycle);
  const overLimit = raw < -0.005 || (input.maxRequests !== null && input.countInCycle > input.maxRequests);
  let available = round2(Math.max(0, raw));
  let blockedReason: string | null = null;
  if (input.maxRequests !== null && input.countInCycle >= input.maxRequests) {
    blockedReason = `เบิกครบ ${input.maxRequests} ครั้งในรอบนี้แล้ว`;
    available = 0;
  } else if (available <= 0) {
    blockedReason = input.earned <= 0 ? "ยังไม่มีวันทำงานในรอบนี้" : "เบิกครบตามค่าแรงที่ทำได้แล้ว";
  }
  return { available, blockedReason, earnedCap, overLimit };
}

export type AdvancePayMethod = "cash" | "transfer";
export const ADVANCE_PAY_METHOD_LABEL: Record<AdvancePayMethod, string> = { cash: "เงินสด", transfer: "โอน" };

/**
 * เบิกเงินสดได้สูงสุด = ไม่เกินเพดานเบิก และไม่เกินเงินสดในลิ้นชักตอนนี้
 * เงินสดปัดลงหลักร้อย — พนักงานไม่เห็นยอดลิ้นชักแบบเป๊ะ และเหลือเงินทอนในลิ้นชัก
 */
export function cashAdvanceMax(available: number, cashOnHand: number): number {
  const cash = Math.floor(Math.max(0, cashOnHand) / 100) * 100;
  return round2(Math.max(0, Math.min(available, cash)));
}

/** ตรวจยอดตามวิธีรับเงิน — คืนข้อความผิดพลาด หรือ null ถ้าผ่าน */
export function checkAdvanceAmount(amount: number, method: AdvancePayMethod, available: number, cashOnHand: number): string | null {
  const fmt = (n: number) => `฿${n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (!(amount > 0)) return "ใส่จำนวนเงินที่ต้องการเบิก";
  if (amount > available) return `เบิกได้ไม่เกิน ${fmt(available)} (ตามค่าแรงจากวันที่มาทำงานแล้ว)`;
  if (method === "cash" && amount > cashAdvanceMax(available, cashOnHand)) {
    const max = cashAdvanceMax(available, cashOnHand);
    return max > 0
      ? `เงินสดในร้านตอนนี้ไม่พอ — เบิกเงินสดได้สูงสุด ${fmt(max)} หรือเลือกรับเป็นเงินโอน`
      : "ตอนนี้ไม่มีเงินสดในร้านพอให้เบิก — เลือกรับเป็นเงินโอนแทน";
  }
  return null;
}

export interface AdvanceDue {
  id: string;
  /** วันที่จ่าย (YYYY-MM-DD) */
  paidDate: string;
  /** ยอดที่ยังไม่ถูกหัก (ไม่นับที่หักในรอบที่กำลังคิดอยู่เอง) */
  outstanding: number;
}

export interface AdvanceAllocation {
  total: number;
  items: { id: string; paidDate: string; amount: number }[];
  /** ยอดที่หักไม่ได้ในรอบนี้ (ยกไปรอบถัดไป) */
  shortfall: number;
}

/** หักเบิกที่จ่ายถึงวันจบรอบ เก่าก่อน ไม่เกิน limit (ยอดสุทธิก่อนหักเบิก) */
export function allocateAdvanceDeduction(dues: readonly AdvanceDue[], periodEnd: string, limit: number): AdvanceAllocation {
  const eligible = dues
    .filter((d) => d.paidDate <= periodEnd && d.outstanding > 0)
    .sort((a, b) => (a.paidDate === b.paidDate ? a.id.localeCompare(b.id) : a.paidDate.localeCompare(b.paidDate)));
  let left = Math.max(0, round2(limit));
  const items: AdvanceAllocation["items"] = [];
  let due = 0;
  for (const d of eligible) {
    due += d.outstanding;
    const amount = round2(Math.min(d.outstanding, left));
    left = round2(left - amount);
    if (amount > 0) items.push({ id: d.id, paidDate: d.paidDate, amount });
  }
  const total = round2(items.reduce((s, i) => s + i.amount, 0));
  return { total, items, shortfall: round2(due - total) };
}
