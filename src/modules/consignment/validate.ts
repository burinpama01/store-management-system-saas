/** ตรวจ/คำนวณฝั่งแอปของสินค้าซื้อขาด/ฝากขาย (pure — เทสต์ได้) · DB ตรวจซ้ำทุกข้อใน RPC */
import type { ConsignPricing, LotAdjustKind, PayoutMethod, ProductSourcingInput, ReceiveLine, SourcingMode } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 999_999;
const round2 = (v: number) => Math.round(v * 100) / 100;

export const MAX_RECEIVE_LINES = 100;
export const MAX_OPTION_COSTS = 100;

/**
 * ต้นทุนและกำไรต่อชิ้น (ไว้แสดงตอนตั้งค่า)
 * - ซื้อขาด / ฝากขายราคาต่อชิ้น: ต้นทุน = ราคาซื้อ/ราคาจ่ายเจ้าของ
 * - ฝากขายหัก %: ต้นทุน = ราคาขาย × (100 − %ร้าน) ÷ 100
 */
export function unitEconomics(input: {
  price: number;
  mode: SourcingMode;
  pricing: ConsignPricing | null;
  storePct: number | null;
  unitCost: number | null;
}): { cost: number | null; profit: number | null; marginPct: number | null } {
  if (input.mode === "made") return { cost: null, profit: null, marginPct: null };
  let cost: number | null;
  if (input.mode === "consignment" && input.pricing === "percent") {
    cost = input.storePct === null ? null : round2((input.price * (100 - input.storePct)) / 100);
  } else {
    cost = input.unitCost;
  }
  if (cost === null) return { cost: null, profit: null, marginPct: null };
  const profit = round2(input.price - cost);
  return { cost, profit, marginPct: input.price > 0 ? Math.round((profit / input.price) * 1000) / 10 : null };
}

export function validateSourcing(input: ProductSourcingInput): { value: ProductSourcingInput } | { error: string } {
  if (!isUuid(input.productId)) return { error: "ข้อมูลเมนูไม่ถูกต้อง" };
  if (!["made", "resale", "consignment"].includes(input.mode)) return { error: "เลือกที่มาของสินค้า" };
  if (input.mode === "made") {
    return {
      value: { productId: input.productId, mode: "made", supplierId: null, pricing: null, storePct: null, unitCost: null, optionGroupId: null, optionCosts: [] },
    };
  }
  if (!isUuid(input.supplierId)) return { error: "เลือกเจ้าของสินค้า" };
  let pricing: ConsignPricing | null = null;
  let storePct: number | null = null;
  if (input.mode === "consignment") {
    if (input.pricing !== "per_unit" && input.pricing !== "percent") return { error: "เลือกวิธีคิดเงินกับเจ้าของ" };
    pricing = input.pricing;
    if (pricing === "percent") {
      if (typeof input.storePct !== "number" || !(input.storePct > 0 && input.storePct < 100)) {
        return { error: "เปอร์เซ็นต์ของร้านต้องมากกว่า 0 และน้อยกว่า 100" };
      }
      storePct = round2(input.storePct);
    }
  }
  const needsCost = !(input.mode === "consignment" && pricing === "percent");
  if (input.unitCost !== null && !money(input.unitCost)) return { error: "ราคาต่อชิ้นไม่ถูกต้อง" };
  if (input.optionGroupId !== null && !isUuid(input.optionGroupId)) return { error: "ข้อมูลกลุ่มรสชาติไม่ถูกต้อง" };
  if (!Array.isArray(input.optionCosts) || input.optionCosts.length > MAX_OPTION_COSTS) return { error: "ข้อมูลรสชาติไม่ถูกต้อง" };
  const optionCosts = input.optionGroupId === null ? [] : input.optionCosts;
  for (const oc of optionCosts) {
    if (!isUuid(oc.optionId)) return { error: "ข้อมูลรสชาติไม่ถูกต้อง" };
    if (oc.unitCost !== null && !money(oc.unitCost)) return { error: "ราคาต่อชิ้นของรสไม่ถูกต้อง" };
  }
  if (needsCost && input.unitCost === null && !(optionCosts.length > 0 && optionCosts.every((o) => o.unitCost !== null))) {
    return { error: input.mode === "resale" ? "ใส่ราคาซื้อต่อชิ้น" : "ใส่ราคาจ่ายเจ้าของต่อชิ้น" };
  }
  return {
    value: {
      productId: input.productId,
      mode: input.mode,
      supplierId: input.supplierId,
      pricing,
      storePct,
      unitCost: input.unitCost === null ? null : round2(input.unitCost),
      optionGroupId: input.optionGroupId,
      optionCosts: optionCosts.map((o) => ({ optionId: o.optionId, unitCost: o.unitCost === null ? null : round2(o.unitCost) })),
    },
  };
}

export function validateReceive(input: {
  supplierId: string;
  mode: "resale" | "consignment";
  lines: ReceiveLine[];
  expiresOn: string | null;
  note: string | null;
  paymentMethod: PayoutMethod | null;
}):
  | { value: typeof input & { total: number } }
  | { error: string } {
  if (!isUuid(input.supplierId)) return { error: "เลือกเจ้าของสินค้า" };
  if (input.mode !== "resale" && input.mode !== "consignment") return { error: "เลือกซื้อขาดหรือฝากขาย" };
  const lines = (Array.isArray(input.lines) ? input.lines : []).filter((l) => l && l.qty > 0);
  if (lines.length === 0) return { error: "ใส่จำนวนอย่างน้อย 1 รายการ" };
  if (lines.length > MAX_RECEIVE_LINES) return { error: `รับของได้ไม่เกิน ${MAX_RECEIVE_LINES} รายการต่อครั้ง` };
  const seen = new Set<string>();
  for (const l of lines) {
    if (!isUuid(l.productId) || (l.optionId !== null && !isUuid(l.optionId))) return { error: "ข้อมูลเมนูไม่ถูกต้อง" };
    if (!Number.isInteger(l.qty) || l.qty <= 0 || l.qty > 100_000) return { error: "จำนวนต้องเป็นจำนวนเต็มมากกว่า 0" };
    if (!money(l.unitCost)) return { error: "ราคาต่อชิ้นไม่ถูกต้อง" };
    const key = `${l.productId}:${l.optionId ?? "-"}`;
    if (seen.has(key)) return { error: "มีเมนู/รสซ้ำในรายการรับของ" };
    seen.add(key);
  }
  if (input.expiresOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn)) return { error: "วันหมดอายุไม่ถูกต้อง" };
  const note = (input.note ?? "").trim().slice(0, 300) || null;
  if (input.mode === "resale" && input.paymentMethod !== "cash" && input.paymentMethod !== "transfer") {
    return { error: "เลือกจ่ายเงินสดหรือโอน" };
  }
  const total = round2(lines.reduce((s, l) => s + round2(l.unitCost) * l.qty, 0));
  return {
    value: {
      ...input,
      lines: lines.map((l) => ({ ...l, unitCost: round2(l.unitCost) })),
      note,
      paymentMethod: input.mode === "resale" ? input.paymentMethod : null,
      total,
    },
  };
}

export function validateAdjust(input: { lotId: string; kind: LotAdjustKind; qty: number; note: string | null }):
  | { value: { lotId: string; kind: LotAdjustKind; qty: number; note: string | null } }
  | { error: string } {
  if (!isUuid(input.lotId)) return { error: "ข้อมูลล็อตไม่ถูกต้อง" };
  if (!["return_owner", "damage", "count_adjust", "store_buyout"].includes(input.kind)) return { error: "เลือกประเภทการปรับ" };
  if (!Number.isInteger(input.qty) || input.qty === 0 || Math.abs(input.qty) > 100_000) return { error: "จำนวนไม่ถูกต้อง" };
  if (input.kind !== "count_adjust" && input.qty < 0) return { error: "จำนวนต้องมากกว่า 0" };
  return { value: { ...input, note: (input.note ?? "").trim().slice(0, 300) || null } };
}

/** ช่วงวันที่รายงาน: YYYY-MM-DD, from ≤ to, ไม่เกิน 92 วัน (ตรงกับ SQL) */
export function validateReportRange(from: string, to: string): { from: string; to: string } | { error: string } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from) || !re.test(to)) return { error: "ช่วงวันที่ไม่ถูกต้อง" };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(days) || days < 0 || days > 92) return { error: "ช่วงวันที่ไม่ถูกต้อง (ไม่เกิน 3 เดือน)" };
  return { from, to };
}
