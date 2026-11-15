/**
 * ระดับสมาชิกแบบ Shopee Rewards — กฎฝั่ง TypeScript (ใช้ตรวจฟอร์มและแสดงผล)
 * ฝั่งตัดสินจริงอยู่ใน SQL: member_tier_rank_for / member_tier_rollover / record_member_tier_activity
 * (supabase/migrations/20261118120000_member_tiers.sql) — สองฝั่งต้องตรงกัน
 */

export type TierMetricMode = "spend" | "orders" | "both" | "either";
export type TierCycleMonths = 3 | 6 | 12;

export interface TierDefinition {
  rank: number;
  name: string;
  color: string;
  minSpend: number;
  minOrders: number;
}

export interface TierProgramInput {
  metricMode: TierMetricMode;
  cycleMonths: TierCycleMonths;
  downgradeOneStep: boolean;
  tiers: TierDefinition[];
}

export const METRIC_MODE_LABELS: Record<TierMetricMode, string> = {
  spend: "ยอดซื้ออย่างเดียว",
  orders: "จำนวนบิลอย่างเดียว",
  both: "ต้องถึงทั้งยอดซื้อและจำนวนบิล (แบบ Shopee)",
  either: "ถึงอย่างใดอย่างหนึ่ง",
};

export const CYCLE_LABELS: Record<TierCycleMonths, string> = {
  3: "รายไตรมาส (ม.ค. / เม.ย. / ก.ค. / ต.ค.)",
  6: "ครึ่งปี (ม.ค.–มิ.ย. / ก.ค.–ธ.ค.)",
  12: "รายปี (ม.ค.–ธ.ค.)",
};

/** ค่าเริ่มต้นตามตัวอย่าง Shopee ที่ผู้ใช้ส่งมา (เจ้าของแก้ได้ทั้งหมด) */
export const DEFAULT_TIERS: TierDefinition[] = [
  { rank: 0, name: "Classic", color: "#e8590c", minSpend: 0, minOrders: 0 },
  { rank: 1, name: "Silver", color: "#868e96", minSpend: 1500, minOrders: 6 },
  { rank: 2, name: "Gold", color: "#f59f00", minSpend: 7500, minOrders: 24 },
  { rank: 3, name: "Platinum", color: "#495057", minSpend: 30000, minOrders: 50 },
];

export function validateTierProgram(input: TierProgramInput): string | null {
  if (!["spend", "orders", "both", "either"].includes(input.metricMode)) return "วิธีวัดระดับไม่ถูกต้อง";
  if (![3, 6, 12].includes(input.cycleMonths)) return "ความยาวรอบไม่ถูกต้อง";
  const tiers = [...input.tiers].sort((a, b) => a.rank - b.rank);
  if (tiers.length < 2 || tiers.length > 6) return "ต้องมี 2–6 ระดับ";
  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i];
    if (tier.rank !== i) return "ลำดับระดับต้องต่อเนื่อง";
    const name = tier.name.trim();
    if (!name || name.length > 40) return `ตั้งชื่อระดับที่ ${i + 1} (ไม่เกิน 40 ตัวอักษร)`;
    if (!/^#[0-9a-fA-F]{6}$/.test(tier.color)) return `สีของระดับ ${name} ไม่ถูกต้อง`;
    if (!Number.isFinite(tier.minSpend) || tier.minSpend < 0) return `ยอดซื้อขั้นต่ำของ ${name} ไม่ถูกต้อง`;
    if (!Number.isInteger(tier.minOrders) || tier.minOrders < 0) return `จำนวนบิลขั้นต่ำของ ${name} ไม่ถูกต้อง`;
    if (i === 0) continue;
    const prev = tiers[i - 1];
    if (tier.minSpend < prev.minSpend || tier.minOrders < prev.minOrders) {
      return `เกณฑ์ของ ${name} ต้องไม่ต่ำกว่า ${prev.name}`;
    }
    if (input.metricMode === "both" && (tier.minSpend <= 0 || tier.minOrders <= 0)) {
      return `โหมดต้องถึงทั้งคู่ ต้องตั้งทั้งยอดซื้อและจำนวนบิลของ ${name} ให้มากกว่า 0`;
    }
    if (input.metricMode === "either" && tier.minSpend <= 0 && tier.minOrders <= 0) return `ตั้งเกณฑ์อย่างน้อยหนึ่งข้อของ ${name}`;
    if (input.metricMode === "spend" && tier.minSpend <= 0) return `ตั้งยอดซื้อขั้นต่ำของ ${name}`;
    if (input.metricMode === "orders" && tier.minOrders <= 0) return `ตั้งจำนวนบิลขั้นต่ำของ ${name}`;
  }
  return null;
}

/** ยอดนี้ถึงเกณฑ์ระดับนี้ไหม — ตรงกับ member_tier_rank_for */
export function meetsTier(mode: TierMetricMode, spend: number, orders: number, tier: Pick<TierDefinition, "minSpend" | "minOrders">): boolean {
  switch (mode) {
    case "spend":
      return spend >= tier.minSpend;
    case "orders":
      return orders >= tier.minOrders;
    case "either":
      return spend >= tier.minSpend || orders >= tier.minOrders;
    default:
      return spend >= tier.minSpend && orders >= tier.minOrders;
  }
}

export function rankFor(mode: TierMetricMode, tiers: TierDefinition[], spend: number, orders: number): number {
  return tiers.reduce((best, tier) => (meetsTier(mode, spend, orders, tier) && tier.rank > best ? tier.rank : best), 0);
}

/** วันเริ่มรอบ (YYYY-MM-DD) ตามเวลาไทย — ตรงกับ member_tier_cycle_start */
export function cycleStart(at: Date, months: TierCycleMonths): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const startMonth = Math.floor((month - 1) / months) * months + 1;
  return `${year}-${String(startMonth).padStart(2, "0")}-01`;
}

/** วันสุดท้ายของรอบ (YYYY-MM-DD) */
export function cycleEnd(start: string, months: TierCycleMonths): string {
  const [y, m] = start.split("-").map(Number);
  const endExclusive = new Date(Date.UTC(y, m - 1 + months, 1));
  endExclusive.setUTCDate(endExclusive.getUTCDate() - 1);
  return endExclusive.toISOString().slice(0, 10);
}

export interface TierProgressLine {
  label: string;
  current: number;
  target: number;
  unit: "baht" | "orders";
}

/**
 * ความคืบหน้าแบบหน้าจอ Shopee: "เพื่อรักษาระดับ" (เกณฑ์ระดับปัจจุบัน) และ "อีกเท่าไรถึงระดับถัดไป"
 * ระดับเริ่มต้นไม่มีเกณฑ์รักษา
 */
export function tierProgress(
  mode: TierMetricMode,
  tiers: TierDefinition[],
  currentRank: number,
  spend: number,
  orders: number,
): { keep: TierProgressLine[]; next: { tier: TierDefinition; lines: TierProgressLine[] } | null } {
  const sorted = [...tiers].sort((a, b) => a.rank - b.rank);
  const current = sorted.find((tier) => tier.rank === currentRank) ?? sorted[0];
  const next = sorted.find((tier) => tier.rank === currentRank + 1) ?? null;
  const lines = (tier: TierDefinition): TierProgressLine[] => {
    const out: TierProgressLine[] = [];
    if (mode !== "spend") out.push({ label: "จำนวนบิล", current: orders, target: tier.minOrders, unit: "orders" });
    if (mode !== "orders") out.push({ label: "ยอดซื้อ", current: spend, target: tier.minSpend, unit: "baht" });
    return out;
  };
  return {
    keep: current && current.rank > 0 ? lines(current) : [],
    next: next ? { tier: next, lines: lines(next) } : null,
  };
}

export interface TierBenefitInput {
  minRank: number;
  name: string;
  discountType: "amount" | "percentage";
  discountValue: number;
  minSubtotal: number;
  usesPerMonth: number;
}

export function validateTierBenefit(input: TierBenefitInput, maxRank: number): string | null {
  const name = input.name.trim();
  if (!name || name.length > 80) return "ตั้งชื่อสิทธิ์ (ไม่เกิน 80 ตัวอักษร)";
  if (!Number.isInteger(input.minRank) || input.minRank < 1 || input.minRank > maxRank) return `เลือกระดับของสิทธิ์ "${name}"`;
  if (!Number.isFinite(input.discountValue) || input.discountValue <= 0) return `มูลค่าส่วนลดของ "${name}" ต้องมากกว่า 0`;
  if (input.discountType === "percentage" && input.discountValue > 100) return `ส่วนลดของ "${name}" เกิน 100%`;
  if (!Number.isFinite(input.minSubtotal) || input.minSubtotal < 0) return `ยอดขั้นต่ำของ "${name}" ไม่ถูกต้อง`;
  if (!Number.isInteger(input.usesPerMonth) || input.usesPerMonth < 1 || input.usesPerMonth > 31) return `จำนวนครั้งต่อเดือนของ "${name}" ต้องเป็น 1–31`;
  return null;
}

export function describeBenefit(b: Pick<TierBenefitInput, "discountType" | "discountValue" | "minSubtotal">): string {
  const value = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(b.discountValue);
  const off = b.discountType === "percentage" ? `ลด ${value}%` : `ลด ฿${value}`;
  return b.minSubtotal > 0 ? `${off} ขั้นต่ำ ฿${new Intl.NumberFormat("th-TH").format(b.minSubtotal)}` : off;
}
