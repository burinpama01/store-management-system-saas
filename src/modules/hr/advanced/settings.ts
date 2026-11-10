/**
 * ตั้งค่า "เงินเดือนขั้นสูง" (แผนสลิป v4 · R32/R33) — สวิตช์ฟีเจอร์ + ขั้นต่าง ๆ
 * ฟีเจอร์ใช้ได้ต่อเมื่อ (1) แพ็กมี advancedPayroll และ (2) เปิดสวิตช์ของตัวเอง — ตรวจฝั่ง server เสมอ
 */

export const PAYROLL_FEATURE_KEYS = [
  "salesTargetBar",
  "salesBonus",
  "monthlySalesBonus",
  "skillPay",
  "seniorityPay",
  "socialSecurity",
  "withholdingTax",
  "payCycle",
  "myPayslip",
  "payrollNotifications",
] as const;

export type PayrollFeatureKey = (typeof PAYROLL_FEATURE_KEYS)[number];
export type PayrollFeatureSwitches = Record<PayrollFeatureKey, boolean>;

export const PAYROLL_FEATURE_LABEL: Record<PayrollFeatureKey, string> = {
  salesTargetBar: "แถบเป้ายอดขายวันนี้ (หน้า POS / ลงเวลา)",
  salesBonus: "โบนัสยอดขายรายวัน",
  monthlySalesBonus: "โบนัสยอดขายรายเดือน (ตามรอบเงินเดือน)",
  skillPay: "ค่าทักษะ / หลายตำแหน่ง",
  seniorityPay: "ค่าอายุงาน",
  socialSecurity: "ประกันสังคม",
  withholdingTax: "ภาษีหัก ณ ที่จ่าย",
  payCycle: "รอบเงินเดือน + ปิดงวดอัตโนมัติ",
  myPayslip: "สลิปของฉัน (พนักงานดูเอง)",
  payrollNotifications: "แจ้งเตือนเงินเดือน",
};

/** ตัวลูก → ตัวแม่ที่ต้องเปิดก่อน */
export const PAYROLL_FEATURE_REQUIRES: Partial<Record<PayrollFeatureKey, PayrollFeatureKey>> = {
  salesTargetBar: "salesBonus",
  myPayslip: "payCycle",
};

export const ALL_PAYROLL_FEATURES_OFF: PayrollFeatureSwitches = Object.fromEntries(
  PAYROLL_FEATURE_KEYS.map((k) => [k, false]),
) as PayrollFeatureSwitches;

/** ตัวแม่ปิด = ตัวลูกปิดตาม (R32) */
export function normalizeSwitches(input: Partial<PayrollFeatureSwitches>): PayrollFeatureSwitches {
  const out = { ...ALL_PAYROLL_FEATURES_OFF };
  for (const key of PAYROLL_FEATURE_KEYS) out[key] = input[key] === true;
  for (const [child, parent] of Object.entries(PAYROLL_FEATURE_REQUIRES) as [PayrollFeatureKey, PayrollFeatureKey][]) {
    if (!out[parent]) out[child] = false;
  }
  return out;
}

/** สวิตช์ที่มีผลจริง: แพ็กไม่มีสิทธิ์ (หรือหมดอายุ) = ปิดทุกตัว แต่ค่าที่ตั้งไว้ไม่ถูกลบ (R33) */
export function effectiveSwitches(entitled: boolean, stored: Partial<PayrollFeatureSwitches>): PayrollFeatureSwitches {
  return entitled ? normalizeSwitches(stored) : { ...ALL_PAYROLL_FEATURES_OFF };
}

export interface SkillTier { count: number; amount: number }
export interface SeniorityTier { months: number; amount: number }
export interface SalesBonusTier { minSales: number; amount: number }
/** per_person = ทุกคนที่มีสิทธิ์ได้เต็มจำนวน · split = ยอดโบนัสเป็นก้อนรวม หารกันตามคนเข้างาน */
export type BonusSplitMode = "per_person" | "split";
export const BONUS_SPLIT_MODES: BonusSplitMode[] = ["per_person", "split"];
export type SalesChannel = "pos" | "qr" | "delivery";
export const SALES_CHANNELS: SalesChannel[] = ["pos", "qr", "delivery"];
export const SALES_CHANNEL_LABEL: Record<SalesChannel, string> = {
  pos: "หน้าร้าน",
  qr: "QR สั่งเอง",
  delivery: "เดลิเวอรี",
};

export interface AdvancedPayrollSettings {
  switches: PayrollFeatureSwitches;
  payCycleStartDay: number;
  /** 0 = วันสุดท้ายของเดือน */
  payDay: number;
  skillTiers: SkillTier[];
  seniorityTiers: SeniorityTier[];
  salesBonusTiers: SalesBonusTier[];
  salesBonusChannels: SalesChannel[];
  /** null = มาสายไม่มีผล */
  salesBonusLateMaxMinutes: number | null;
  salesRecordBonus: number;
  salesRecordMode: "replace" | "stack";
  salesRecordBaseline: number;
  /** โบนัสรายวัน: ต่อคน หรือ หารตามจำนวนคนที่ทำเต็มวันวันนั้น */
  salesBonusMode: BonusSplitMode;
  /** พนักงานที่ร่วมโบนัสยอดขาย (รายวัน+รายเดือน) · null = พนักงานประจำทุกคน (แบบเดิม) */
  salesBonusUserIds: string[] | null;
  /** โบนัสรายเดือน: ยอดรวมทั้งรอบเงินเดือน=โบนัส */
  monthlyBonusTiers: SalesBonusTier[];
  /** โบนัสรายเดือน: ต่อคน หรือ หารตามจำนวนวันที่ทำเต็มวัน */
  monthlyBonusMode: BonusSplitMode;
  ssoRate: number;
  ssoWageFloor: number;
  ssoWageCeiling: number;
  whtMode: "manual" | "percent";
  /** วันที่เปิดรอบเงินเดือน — ปิดอัตโนมัติเฉพาะงวดที่จบตั้งแต่วันนี้ */
  payCycleEnabledAt?: string | null;
}

export const DEFAULT_ADVANCED_PAYROLL_SETTINGS: AdvancedPayrollSettings = {
  switches: { ...ALL_PAYROLL_FEATURES_OFF },
  payCycleStartDay: 1,
  payDay: 0,
  skillTiers: [
    { count: 1, amount: 500 },
    { count: 2, amount: 1000 },
    { count: 3, amount: 1500 },
  ],
  seniorityTiers: [
    { months: 6, amount: 300 },
    { months: 12, amount: 600 },
    { months: 24, amount: 900 },
    { months: 36, amount: 1200 },
  ],
  salesBonusTiers: [
    { minSales: 30000, amount: 100 },
    { minSales: 35000, amount: 150 },
    { minSales: 40000, amount: 250 },
  ],
  salesBonusChannels: ["pos", "qr", "delivery"],
  salesBonusLateMaxMinutes: null,
  salesRecordBonus: 500,
  salesRecordMode: "replace",
  salesRecordBaseline: 0,
  salesBonusMode: "per_person",
  salesBonusUserIds: null,
  monthlyBonusTiers: [
    { minSales: 900000, amount: 1000 },
    { minSales: 1000000, amount: 2000 },
  ],
  monthlyBonusMode: "per_person",
  ssoRate: 5,
  ssoWageFloor: 1650,
  ssoWageCeiling: 17500,
  whtMode: "manual",
};

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * อ่านขั้นจาก jsonb หรือข้อความ "6=300, 12=600" — คืนรายการเรียงจากน้อยไปมาก ตัดแถวผิดทิ้ง
 * คีย์ซ้ำ = เก็บตัวหลังสุด
 */
export function parseTiers<K extends "count" | "months" | "minSales">(
  raw: unknown,
  key: K,
  opts: { maxKey: number; maxAmount: number },
): ({ [P in K]: number } & { amount: number })[] {
  let rows: unknown[] = [];
  if (Array.isArray(raw)) rows = raw;
  else if (typeof raw === "string") {
    rows = raw
      .split(/[\n,;]+/)
      .map((part) => part.split(/[=:]/).map((s) => s.trim()))
      .filter((p) => p.length === 2 && p[0] && p[1])
      .map(([k, a]) => ({ [key]: k, amount: a }));
  }
  const byKey = new Map<number, number>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const k = num((row as Record<string, unknown>)[key]);
    const amount = num((row as Record<string, unknown>).amount);
    if (k === null || amount === null) continue;
    if (k <= 0 || k > opts.maxKey || amount < 0 || amount > opts.maxAmount) continue;
    byKey.set(Math.round(k * 100) / 100, Math.round(amount * 100) / 100);
  }
  return [...byKey.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, amount]) => ({ [key]: k, amount }) as { [P in K]: number } & { amount: number });
}

/** แสดงขั้นเป็นข้อความแก้ง่าย "6=300, 12=600" */
export function formatTiers(rows: { amount: number }[], key: "count" | "months" | "minSales"): string {
  return rows.map((r) => `${(r as unknown as Record<string, number>)[key]}=${r.amount}`).join(", ");
}
