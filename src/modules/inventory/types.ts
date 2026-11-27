/** คลังวัตถุดิบ (เฟส A) — Plan/Purchasing and Ingredient Inventory Plan v1.html */

export const MOVEMENT_TYPES = [
  "opening",
  "manual_adjust",
  "receive",
  "receive_void",
  "negative_reset",
  "sale_usage",
  "sale_restore",
  "waste",
  "count_adjust",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  opening: "ยอดยกมา",
  manual_adjust: "ปรับยอด",
  receive: "รับเข้า",
  receive_void: "ยกเลิกรับเข้า",
  negative_reset: "ใช้เกินก่อนรับของ (ล้างติดลบ)",
  sale_usage: "ใช้ตามสูตร (ขาย)",
  sale_restore: "คืนจากยกเลิกบิล",
  waste: "ของเสีย",
  count_adjust: "ปรับจากการนับ",
};

export interface Supplier {
  id: string;
  name: string;
  taxId: string | null;
  branchCode: string | null;
  contactName: string | null;
  phone: string | null;
  lineId: string | null;
  address: string | null;
  note: string | null;
  leadDays: number;
  paymentTermsDays: number;
  isActive: boolean;
  /** ฝากขาย (เฟส C0): เจ้าของรับเงินสดหรือโอน */
  payoutMethod: PayoutMethod;
  /** ฝากขาย: พร้อมเพย์/เลขบัญชี (ข้อความแสดงผล) */
  payoutAccount: string | null;
  /** ฝากขาย: เคลียร์เงินทุกวันตอนปิดรอบ หรือตอนเติมของ */
  settleCycle: SettleCycle;
}

export type PayoutMethod = "cash" | "transfer";
export type SettleCycle = "daily" | "restock";

/** ช่องฝากขายของผู้ขาย — ส่งมาเฉพาะจากหน้าที่มีสิทธิ์ฝากขาย ไม่งั้นค่าเดิมใน DB ไม่ถูกแตะ */
export interface SupplierConsignmentInput {
  payoutMethod: PayoutMethod;
  payoutAccount: string | null;
  settleCycle: SettleCycle;
}

export interface SupplierInput {
  id?: string | null;
  name: string;
  taxId: string | null;
  branchCode: string | null;
  contactName: string | null;
  phone: string | null;
  lineId: string | null;
  address: string | null;
  note: string | null;
  leadDays: number;
  paymentTermsDays: number;
  isActive: boolean;
  consignment?: SupplierConsignmentInput | null;
}

/** แถวที่หน้าคลังแสดง: วัตถุดิบ + ยอดคงเหลือ (ถ้ายังไม่ตั้งยอดยกมา stock = null) */
export interface InventoryItem {
  ingredientId: string;
  name: string;
  purchaseUnit: string;
  usageUnit: string;
  usagePerPurchase: number;
  purchasePrice: number;
  isActive: boolean;
  reorderPoint: number | null;
  safetyDays: number;
  defaultSupplierId: string | null;
  onHand: number | null;
  avgUnitCost: number | null;
  updatedAt: string | null;
}

export interface InventoryMovement {
  id: string;
  ingredientId: string;
  movementType: MovementType;
  qtyDelta: number;
  beforeQty: number;
  afterQty: number;
  unitCost: number;
  reason: string | null;
  createdAt: string;
}

export type StockStatus = "unset" | "negative" | "out" | "low" | "ok";
