/** สินค้าซื้อขาด/ฝากขาย (เฟส C1–C4) — Plan/Resale and Consignment Goods Implementation Plan v2.html */

export type SourcingMode = "made" | "resale" | "consignment";
export type ConsignPricing = "per_unit" | "percent";
export type PayoutMethod = "cash" | "transfer";
export type SettleTrigger = "daily_close" | "restock" | "manual";
export type LotAdjustKind = "return_owner" | "damage" | "count_adjust" | "store_buyout";

export const SOURCING_LABEL: Record<SourcingMode, string> = {
  made: "ทำเอง",
  resale: "ซื้อมาขาย (ซื้อขาด)",
  consignment: "รับฝากขาย",
};

export interface ResaleOption {
  id: string;
  name: string;
  priceAdjustment: number;
  isActive: boolean;
  resaleUnitCost: number | null;
}

export interface ResaleGroup {
  id: string;
  name: string;
  options: ResaleOption[];
}

export interface ResaleProduct {
  id: string;
  name: string;
  basePrice: number;
  isActive: boolean;
  sourcingMode: SourcingMode;
  supplierId: string | null;
  consignPricing: ConsignPricing | null;
  consignStorePct: number | null;
  resaleUnitCost: number | null;
  resaleOptionGroupId: string | null;
  groups: ResaleGroup[];
  /** ใช้สต็อกแบบเดิม (track_stock/stock pool) อยู่ → ตั้งเป็นซื้อมาขายไม่ได้ */
  usesVariantStock: boolean;
}

export interface ProductSourcingInput {
  productId: string;
  mode: SourcingMode;
  supplierId: string | null;
  pricing: ConsignPricing | null;
  storePct: number | null;
  unitCost: number | null;
  optionGroupId: string | null;
  optionCosts: Array<{ optionId: string; unitCost: number | null }>;
}

export interface StockLevel {
  productId: string;
  optionId: string | null;
  onHand: number;
  nearestExpiry: string | null;
}

export interface ResaleLot {
  id: string;
  productId: string;
  optionId: string | null;
  supplierId: string;
  mode: "resale" | "consignment";
  qtyReceived: number;
  qtyRemaining: number;
  unitCost: number;
  expiresOn: string | null;
  receivedAt: string;
}

export interface ReceiveLine {
  productId: string;
  optionId: string | null;
  qty: number;
  unitCost: number;
}

export interface NeedsFlavorRow {
  movementId: string;
  productId: string;
  qty: number;
  createdAt: string;
}

export interface SettlementPreview {
  supplierId: string;
  name: string;
  payoutMethod: PayoutMethod;
  payoutAccount: string | null;
  settleCycle: "daily" | "restock";
  lines: Array<{ productId: string; optionId: string | null; qty: number; gross: number; due: number }>;
  qtySold: number;
  grossSales: number;
  ownerDue: number;
  clawback: number;
  carryIn: number;
  total: number;
  pendingRows: number;
}

export interface SettlementRow {
  id: string;
  supplierId: string;
  triggerKind: SettleTrigger;
  qtySold: number;
  grossSales: number;
  ownerDue: number;
  clawback: number;
  carryIn: number;
  carryOut: number;
  paidAmount: number;
  payoutMethod: PayoutMethod | null;
  settledAt: string;
}

export interface DailyReportRow {
  day: string;
  supplierId: string;
  productId: string;
  optionId: string | null;
  mode: "resale" | "consignment";
  qtySold: number;
  grossSales: number;
  ownerDue: number;
  resaleCost: number;
  storeProfit: number;
  unsettledDue: number;
  damagedStore: number;
  damagedOwner: number;
  returned: number;
  boughtOut: number;
}
