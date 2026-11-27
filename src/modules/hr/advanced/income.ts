/**
 * ส่วนรายได้/รายหักของ "เงินเดือนขั้นสูง" — ฟังก์ชันล้วน (ไม่แตะ DB) เพื่อเทสต์กติกาได้ครบ
 * ②③ ใช้สถานะ ณ วันแรกของงวด (R9) · ②③④ เฉพาะพนักงานประจำ (R1, R8)
 */
import type { EmployeeProfile, PayType } from "../types";
import type { PayrollDay } from "../payroll";
import type { BonusSplitMode, SalesBonusTier, SeniorityTier, SkillTier } from "./settings";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isPermanentOn(
  profile: Pick<EmployeeProfile, "employmentType" | "permanentSince" | "employmentEndDate"> | undefined,
  date: string,
): boolean {
  if (!profile || profile.employmentType !== "permanent") return false;
  if (!profile.permanentSince || profile.permanentSince > date) return false;
  if (profile.employmentEndDate && profile.employmentEndDate < date) return false;
  return true;
}

export interface EmployeeSkillGrant {
  skillId: string;
  skillName: string;
  grantedAt: string;
  revokedAt?: string | null;
}

/** ทักษะที่มีผล ณ วันที่ asOf (ได้รับแล้ว และยังไม่ถูกถอน) */
export function activeSkillsOn(grants: EmployeeSkillGrant[], asOf: string): EmployeeSkillGrant[] {
  return grants.filter((g) => g.grantedAt <= asOf && (!g.revokedAt || g.revokedAt > asOf));
}

/** ขั้นสูงสุดที่ถึง: ทักษะ n ตัว → เงินของขั้น count ≤ n ที่มากที่สุด */
export function skillPayFor(skillCount: number, tiers: SkillTier[]): number {
  let amount = 0;
  for (const t of tiers) if (skillCount >= t.count) amount = t.amount;
  return amount;
}

/** อายุงานเป็นเดือนเต็ม ณ วันที่ asOf */
export function fullMonthsBetween(start: string | undefined, asOf: string): number {
  if (!start || start > asOf) return 0;
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ay, am, ad] = asOf.split("-").map(Number);
  let months = (ay - sy) * 12 + (am - sm);
  if (ad < sd) months -= 1;
  return Math.max(0, months);
}

export function seniorityPayFor(months: number, tiers: SeniorityTier[]): number {
  let amount = 0;
  for (const t of tiers) if (months >= t.months) amount = t.amount;
  return amount;
}

/** ขั้นถัดไป (ไว้บอกพนักงาน "อีกนิดได้เพิ่ม") */
export function nextTier<T extends { amount: number }>(
  value: number,
  tiers: T[],
  key: keyof T,
): T | null {
  for (const t of tiers) if ((t[key] as unknown as number) > value) return t;
  return null;
}

export interface SalesDay {
  date: string;
  sales: number;
  /** โบนัสต่อคนตามขั้น (ยังไม่รวมสถิติ) */
  tierAmount: number;
  /** ทำสถิติยอดขายสูงสุดของสาขา */
  isRecord: boolean;
  /** โบนัสต่อคนที่ใช้จริงของวันนั้น */
  bonusPerPerson: number;
  /** ยอดสถิติก่อนวันนี้ (ใช้คิดโบนัสจากยอดที่ตัดตามเวลาออกงานในวันให้ OT) */
  recordBefore?: number;
}

/** โบนัสต่อคนจากยอดหนึ่ง ๆ — สูตรเดียวกับระดับสาขา (ขั้น + สถิติ แบบแทน/ซ้อน) */
export function salesDayBonusFor(
  sales: number,
  recordBefore: number,
  cfg: { tiers: SalesBonusTier[]; recordBonus: number; recordMode: "replace" | "stack" },
): { tierAmount: number; isRecord: boolean; bonusPerPerson: number } {
  const tierAmount = tierAmountFor(sales, cfg.tiers);
  const isRecord = sales > 0 && sales > recordBefore && cfg.recordBonus > 0;
  const bonusPerPerson = isRecord ? (cfg.recordMode === "stack" ? tierAmount + cfg.recordBonus : cfg.recordBonus) : tierAmount;
  return { tierAmount, isRecord, bonusPerPerson: round2(bonusPerPerson) };
}

export function tierAmountFor(sales: number, tiers: SalesBonusTier[]): number {
  let amount = 0;
  for (const t of tiers) if (sales >= t.minSales) amount = t.amount;
  return amount;
}

/**
 * คำนวณระดับสาขา: ยอดแต่ละวัน → ขั้นโบนัส + ทำสถิติไหม (R6)
 * สถิติ = ยอดเกินยอดสูงสุดก่อนหน้า (ประวัติก่อนงวด + วันก่อนหน้าในงวด + ยอดเริ่มต้นที่ร้านตั้ง)
 */
export function computeStoreSalesDays(input: {
  dailySales: Map<string, number>;
  dates: string[];
  tiers: SalesBonusTier[];
  recordBaseline: number;
  maxBeforePeriod: number;
  recordBonus: number;
  recordMode: "replace" | "stack";
}): Map<string, SalesDay> {
  const out = new Map<string, SalesDay>();
  let record = Math.max(input.recordBaseline, input.maxBeforePeriod);
  for (const date of [...input.dates].sort()) {
    const sales = round2(input.dailySales.get(date) ?? 0);
    const b = salesDayBonusFor(sales, record, input);
    out.set(date, { date, sales, tierAmount: b.tierAmount, isRecord: b.isRecord, bonusPerPerson: b.bonusPerPerson, recordBefore: record });
    if (sales > record) record = sales;
  }
  return out;
}

export interface SalesBonusDayShare {
  date: string;
  amount: number;
  record: boolean;
  /** โหมดหาร: ก้อนรวมของวัน และจำนวนคนที่หาร */
  pool?: number;
  people?: number;
  /** วันให้ OT ที่ออกงานก่อนจบช่วง OT: ยอดขายตอนออกงาน (โบนัสคิดจากยอดนี้) */
  cutoffSales?: number;
  /** โหมดหารแบบเป็นชั้น (วันให้ OT ที่แต่ละคนได้ขั้นต่างกัน) — amount ≠ pool ÷ people */
  layered?: true;
}

export interface EmployeeSalesBonus {
  total: number;
  days: SalesBonusDayShare[];
}

/**
 * โบนัสยอดขายของพนักงานหนึ่งคน (R1–R3): เฉพาะวันที่ทำเต็มวัน (full) และเป็นประจำ ณ วันนั้น
 * ทำวันหยุดได้ปกติ · มาสายเกินเกณฑ์ร้าน = ไม่ได้วันนั้น
 */
export function employeeSalesBonus(input: {
  days: PayrollDay[];
  storeDays: Map<string, SalesDay>;
  isEligibleOn: (date: string) => boolean;
  lateMaxMinutes: number | null;
}): EmployeeSalesBonus {
  const out: EmployeeSalesBonus = { total: 0, days: [] };
  for (const day of input.days) {
    if (day.status !== "full") continue;
    const store = input.storeDays.get(day.date);
    if (!store || store.bonusPerPerson <= 0) continue;
    if (!input.isEligibleOn(day.date)) continue;
    if (input.lateMaxMinutes !== null && day.lateMinutes > input.lateMaxMinutes) continue;
    out.days.push({ date: day.date, amount: store.bonusPerPerson, record: store.isRecord });
    out.total = round2(out.total + store.bonusPerPerson);
  }
  return out;
}

/** ผู้ที่มีสิทธิ์โบนัสยอดขาย ณ วันหนึ่ง: เลือกรายชื่อไว้ = เฉพาะคนในรายชื่อ · ไม่เลือก = พนักงานประจำ (แบบเดิม) */
export function salesBonusEligible(
  selectedUserIds: string[] | null,
  userId: string,
  profile: Pick<EmployeeProfile, "employmentType" | "permanentSince" | "employmentEndDate"> | undefined,
  date: string,
): boolean {
  if (profile?.employmentEndDate && profile.employmentEndDate < date) return false;
  if (selectedUserIds) return selectedUserIds.includes(userId);
  return isPermanentOn(profile, date);
}

/**
 * โบนัสยอดขายรายวันของทั้งร้าน
 * - per_person: ทุกคนที่ผ่านเกณฑ์ได้ "โบนัสต่อคน" เต็มจำนวน (เหมือนเดิม)
 * - split: โบนัสของวันเป็นก้อนรวม หารเท่ากันตามจำนวนคนที่ผ่านเกณฑ์วันนั้น (ทำเต็มวัน + มีสิทธิ์ + ไม่สายเกินเกณฑ์)
 *   ปัดเศษ 2 ตำแหน่งต่อคน (ผลรวมอาจต่างจากก้อนรวม ±0.01 ต่อวัน)
 */
export function computeDailySalesBonuses(input: {
  employees: { userId: string; days: PayrollDay[] }[];
  storeDays: Map<string, SalesDay>;
  isEligibleOn: (userId: string, date: string) => boolean;
  lateMaxMinutes: number | null;
  mode: BonusSplitMode;
  /**
   * วันให้ OT: ยอดขายตอนที่คนนี้ออกงาน (ออกก่อนจบช่วง OT) — null = ได้ตามยอดทั้งวัน (อยู่จนจบ OT / ไม่ใช่วัน OT)
   * มีผลเมื่อส่ง personalBonusFor มาด้วย
   */
  cutoffSalesFor?: (userId: string, day: PayrollDay) => number | null;
  /** โบนัสต่อคนจากยอดที่ตัด (สูตรเดียวกับระดับสาขา) */
  personalBonusFor?: (sales: number, store: SalesDay) => { bonusPerPerson: number; isRecord: boolean };
}): Map<string, EmployeeSalesBonus> {
  // ระดับโบนัสของคนหนึ่งในวันนั้น: ปกติ = ของทั้งวัน · ออกก่อนจบ OT = จากยอดตอนออกงาน (ไม่เกินของทั้งวัน)
  const levelOf = (userId: string, day: PayrollDay, store: SalesDay): { level: number; record: boolean; cut?: number } => {
    const cut = input.cutoffSalesFor && input.personalBonusFor ? input.cutoffSalesFor(userId, day) : null;
    if (cut === null || cut === undefined || !(cut < store.sales)) return { level: store.bonusPerPerson, record: store.isRecord };
    const sales = round2(Math.max(0, cut));
    const b = input.personalBonusFor!(sales, store);
    return { level: Math.min(b.bonusPerPerson, store.bonusPerPerson), record: b.isRecord, cut: sales };
  };
  const qualifies = (userId: string, day: PayrollDay) =>
    day.status === "full" &&
    (input.storeDays.get(day.date)?.bonusPerPerson ?? 0) > 0 &&
    input.isEligibleOn(userId, day.date) &&
    !(input.lateMaxMinutes !== null && day.lateMinutes > input.lateMaxMinutes);

  // ระดับของทุกคนที่ผ่านเกณฑ์ ต่อวัน (โหมดหารต้องรู้ทั้งร้าน)
  const levelsByDate = new Map<string, number[]>();
  for (const emp of input.employees) {
    for (const day of emp.days) {
      if (!qualifies(emp.userId, day)) continue;
      const arr = levelsByDate.get(day.date) ?? [];
      arr.push(levelOf(emp.userId, day, input.storeDays.get(day.date) as SalesDay).level);
      levelsByDate.set(day.date, arr);
    }
  }

  const out = new Map<string, EmployeeSalesBonus>();
  for (const emp of input.employees) {
    const result: EmployeeSalesBonus = { total: 0, days: [] };
    for (const day of emp.days) {
      if (!qualifies(emp.userId, day)) continue;
      const store = input.storeDays.get(day.date) as SalesDay;
      const { level, record, cut } = levelOf(emp.userId, day, store);
      const extra = cut !== undefined ? { cutoffSales: cut } : {};
      if (input.mode === "split") {
        const levels = levelsByDate.get(day.date) ?? [level];
        const amount = round2(layeredShare(level, levels));
        if (amount <= 0 && cut !== undefined) continue;
        const layered = levels.some((l) => l !== levels[0]) ? { layered: true as const } : {};
        result.days.push({ date: day.date, amount, record, pool: store.bonusPerPerson, people: levels.length, ...extra, ...layered });
        result.total = round2(result.total + amount);
      } else {
        if (level <= 0) continue;
        result.days.push({ date: day.date, amount: level, record, ...extra });
        result.total = round2(result.total + level);
      }
    }
    out.set(emp.userId, result);
  }
  return out;
}

/**
 * โหมดหารแบบเป็นชั้น (วันให้ OT): โบนัสแต่ละขั้นที่เพิ่มขึ้น หารเฉพาะคนที่ยังอยู่ตอนยอดถึงขั้นนั้น
 * ทุกคนระดับเท่ากัน (วันปกติ) = ก้อนรวม ÷ จำนวนคน เหมือนเดิม
 */
export function layeredShare(level: number, levels: readonly number[]): number {
  const steps = [...new Set(levels.filter((l) => l > 0))].sort((a, b) => a - b);
  let prev = 0;
  let share = 0;
  for (const step of steps) {
    if (step > level) break;
    const holders = levels.filter((l) => l >= step).length;
    if (holders > 0) share += (step - prev) / holders;
    prev = step;
  }
  return share;
}

export interface MonthlySalesBonus {
  amount: number;
  /** วันทำเต็มวันที่มีสิทธิ์ในรอบนี้ */
  fullDays: number;
  /** ยอดขายรวมของรอบ */
  periodSales: number;
  /** โบนัสตามขั้น (ต่อคน หรือ ก้อนรวมในโหมดหาร) */
  tierAmount: number;
  /** โหมดหาร: วันทำงานรวมของทุกคนที่มีสิทธิ์ */
  totalFullDays?: number;
}

/**
 * โบนัสยอดขายรายเดือน (ตามรอบเงินเดือน): ยอดรวมทั้งรอบ → ขั้นโบนัส
 * - per_person: คนที่มีสิทธิ์และทำเต็มวันอย่างน้อย 1 วันในรอบ ได้เต็มจำนวน
 * - split: ก้อนรวมหารตามสัดส่วนวันทำเต็มวันของแต่ละคน ต่อวันทำเต็มวันรวมของทุกคนที่มีสิทธิ์ทั้งรอบ
 * เกณฑ์มาสาย (salesBonusLateMaxMinutes) ใช้กับโบนัสรายวันเท่านั้น — รายเดือนเป็นรางวัลผลยอดทั้งรอบ นับทุกวันที่ทำเต็มวัน
 */
export function computeMonthlySalesBonuses(input: {
  employees: { userId: string; days: PayrollDay[] }[];
  periodSales: number;
  tiers: SalesBonusTier[];
  isEligibleOn: (userId: string, date: string) => boolean;
  mode: BonusSplitMode;
}): Map<string, MonthlySalesBonus> {
  const periodSales = round2(input.periodSales);
  const tierAmount = tierAmountFor(periodSales, input.tiers);
  const fullDays = new Map<string, number>();
  for (const emp of input.employees) {
    fullDays.set(emp.userId, emp.days.filter((d) => d.status === "full" && input.isEligibleOn(emp.userId, d.date)).length);
  }
  const totalFullDays = [...fullDays.values()].reduce((s, n) => s + n, 0);
  const out = new Map<string, MonthlySalesBonus>();
  for (const emp of input.employees) {
    const days = fullDays.get(emp.userId) ?? 0;
    let amount = 0;
    if (tierAmount > 0 && days > 0) {
      amount = input.mode === "split" ? round2((tierAmount * days) / totalFullDays) : tierAmount;
    }
    out.set(emp.userId, {
      amount,
      fullDays: days,
      periodSales,
      tierAmount,
      ...(input.mode === "split" ? { totalFullDays } : {}),
    });
  }
  return out;
}

/** ประกันสังคม (R19): ฐาน = รายได้ (รวมค่าทักษะ/อายุงาน/โบนัส) ตัดที่ฐานต่ำสุด–สูงสุด ปัดเป็นบาท */
export function socialSecurityFor(
  wageBase: number,
  cfg: { rate: number; floor: number; ceiling: number },
): { base: number; amount: number } {
  if (!(wageBase > 0) || !(cfg.rate > 0)) return { base: 0, amount: 0 };
  const base = Math.min(cfg.ceiling, Math.max(cfg.floor, wageBase));
  return { base: round2(base), amount: Math.round((base * cfg.rate) / 100) };
}

/** ภาษีโหมด % คงที่ต่อคน (R28 เฟสแรก) */
export function withholdingTaxPercent(taxableIncome: number, ratePercent: number): number {
  if (!(taxableIncome > 0) || !(ratePercent > 0)) return 0;
  return round2((taxableIncome * ratePercent) / 100);
}

// ---------------------------------------------------------------------------
// ประวัติเรท (R13, R29)
// ---------------------------------------------------------------------------
export interface PayRateEntry {
  payType: PayType;
  monthlySalary: number;
  dailyRate: number;
  hourlyRate: number;
  effectiveFrom: string;
}

/** เรทที่มีผล ณ วันที่ date — ไม่มีประวัติก่อนวันนั้น = undefined (ใช้เรทในโปรไฟล์) */
export function rateOn(rates: PayRateEntry[], date: string): PayRateEntry | undefined {
  let found: PayRateEntry | undefined;
  for (const r of [...rates].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))) {
    if (r.effectiveFrom <= date) found = r;
  }
  return found;
}

/** แบ่งงวดเป็นช่วงตามเรทที่มีผล — ช่วงที่ไม่มีประวัติใช้ fallback */
export function rateSegments(
  rates: PayRateEntry[],
  from: string,
  to: string,
  fallback: PayRateEntry,
): { from: string; to: string; days: number; rate: PayRateEntry }[] {
  const sorted = [...rates].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const cuts = sorted.map((r) => r.effectiveFrom).filter((d) => d > from && d <= to);
  const starts = [from, ...cuts];
  const segs: { from: string; to: string; days: number; rate: PayRateEntry }[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const s = starts[i];
    const next = starts[i + 1];
    const e = next ? new Date(Date.parse(`${next}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : to;
    const days = Math.round((Date.parse(`${e}T12:00:00Z`) - Date.parse(`${s}T12:00:00Z`)) / 86_400_000) + 1;
    segs.push({ from: s, to: e, days, rate: rateOn(sorted, s) ?? fallback });
  }
  return segs;
}

function rateKey(r: PayRateEntry): string {
  return `${r.payType}|${r.monthlySalary}|${r.dailyRate}|${r.hourlyRate}`;
}

/** งวดนี้มีเรทมากกว่า 1 แบบไหม */
export function hasMultipleRates(segments: { rate: PayRateEntry }[]): boolean {
  return new Set(segments.map((s) => rateKey(s.rate))).size > 1;
}
