export interface Category {
  id: string;
  storeId: string;
  organizationId: string;
  name: string;
  description?: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  storeId: string;
  organizationId: string;
  categoryId: string;
  menuLinkId?: string;
  kitchenStationId?: string;
  name: string;
  description?: string;
  barcode?: string;
  imageUrl?: string;
  basePrice: number;
  /** หน่วยนับฐานของสินค้า เช่น ชิ้น/ขวด/ถุง (แสดงผลอย่างเดียว) */
  unitLabel?: string;
  /** ราคาต่อระดับลูกค้า — null/undefined = ใช้ราคาปลีก (basePrice) */
  priceWholesale?: number | null;
  priceAgent?: number | null;
  priceRegular?: number | null;
  isActive: boolean;
  availableForPos: boolean;
  availableForQr: boolean;
  availableForDelivery?: boolean;
  deliveryPrice?: number | null;
  deliveryOutOfStock?: boolean;
  /** ของหมด (ปิดขายชั่วคราวหน้าร้าน/QR แต่ยังอยู่ในเมนู) */
  outOfStock?: boolean;
  sortOrder: number;
  variants: ProductVariant[];
  /** หน่วยขายแพ็ค (โหล/ลัง) — undefined ในโค้ดเก่า = ไม่มีหน่วยแพ็ค */
  units?: ProductUnit[];
  modifierGroups: ModifierGroup[];
  createdAt: string;
  updatedAt: string;
}

/** หน่วยขายแบบแพ็ค เช่น โหล = 12 ชิ้น ราคาเหมา 690 (ตัดสต๊อก quantity ชิ้นต่อ 1 หน่วย) */
export interface ProductUnit {
  id: string;
  productId: string;
  storeId: string;
  name: string;
  quantity: number;
  price: number;
  priceWholesale?: number | null;
  priceAgent?: number | null;
  priceRegular?: number | null;
  barcode?: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Stock Pool ที่ variant นี้ผูกอยู่ — เมื่อมีค่านี้ Pool คือ "แหล่งความจริงเดียว"
 * ของสต๊อก: ห้ามใช้ stockQuantity ตัดสินว่าขายได้ไหม (RPC ก็ไม่ตัด variant stock
 * ให้รายการที่ผูก Pool เช่นกัน มิฉะนั้นจะกลายเป็นสองแหล่งที่ไม่ตรงกัน)
 */
export interface VariantStockPool {
  poolId: string;
  poolName: string;
  unitLabel: string;
  /** ยอดคงเหลือของ Pool (หน่วยของ Pool) */
  quantity: number;
  /** ยอดที่จองไว้ให้ออเดอร์ QR ที่ครัวยังไม่รับ — ขายได้จริง = quantity − reservedUnits */
  reservedUnits: number;
  /** ขาย variant นี้ 1 หน่วยฐาน ตัดจาก Pool กี่หน่วย */
  consumptionQuantity: number;
}

export interface ProductVariant {
  id: string;
  productId: string;
  name: string;
  barcode?: string;
  priceAdjustment: number;
  sku?: string;
  /** สต๊อกจริง (หน้าจัดการสต๊อกแก้ค่านี้) — ตัดสินว่าขายได้ไหมให้ใช้ availableVariantStock() */
  stockQuantity?: number;
  /** ยอดจองของออเดอร์ QR ที่ครัวยังไม่รับ */
  reservedQuantity?: number;
  trackStock: boolean;
  isActive: boolean;
  sortOrder: number;
  stockPool?: VariantStockPool;
}

/** ยอดพร้อมขาย = สต๊อกจริง − ยอดจอง (undefined = ไม่ได้ติดตามสต๊อก) */
export function availableVariantStock(variant: Pick<ProductVariant, "trackStock" | "stockQuantity" | "reservedQuantity">): number | undefined {
  if (!variant.trackStock || typeof variant.stockQuantity !== "number") return undefined;
  return variant.stockQuantity - (variant.reservedQuantity ?? 0);
}

/** ยอดพร้อมขายของ Pool (หน่วยของ Pool) */
export function availablePoolUnits(pool: Pick<VariantStockPool, "quantity" | "reservedUnits">): number {
  return pool.quantity - (pool.reservedUnits ?? 0);
}

/**
 * ขาย variant นี้ได้อีกกี่ชิ้น (Pool มาก่อน — Pool คือแหล่งความจริงเดียวเมื่อผูกอยู่)
 * undefined = ไม่ได้ติดตามสต๊อก (ขายได้ไม่จำกัด)
 */
export function sellableVariantUnits(variant: ProductVariant): number | undefined {
  if (variant.stockPool) {
    const consumption = variant.stockPool.consumptionQuantity;
    if (!(consumption > 0)) return undefined;
    return Math.max(0, Math.floor(availablePoolUnits(variant.stockPool) / consumption));
  }
  const available = availableVariantStock(variant);
  return available === undefined ? undefined : Math.max(0, available);
}

export interface VariantTemplate {
  id: string;
  storeId: string;
  name: string;
  priceAdjustment: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type ModifierSelectionType = "single" | "multiple";

export interface ModifierOptionTemplate {
  id: string;
  modifierGroupTemplateId: string;
  name: string;
  priceAdjustment: number;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModifierGroupTemplate {
  id: string;
  storeId: string;
  name: string;
  selectionType: ModifierSelectionType;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
  options: ModifierOptionTemplate[];
  createdAt: string;
  updatedAt: string;
}

export interface ModifierGroup {
  id: string;
  productId: string;
  name: string;
  selectionType: ModifierSelectionType;
  isRequired: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder: number;
  options: ModifierOption[];
}

export interface ModifierOption {
  id: string;
  modifierGroupId: string;
  name: string;
  priceAdjustment: number;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface ProductWithDetails extends Product {
  category: Category;
}
