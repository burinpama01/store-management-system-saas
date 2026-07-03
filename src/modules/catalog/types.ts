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

export interface ProductVariant {
  id: string;
  productId: string;
  name: string;
  barcode?: string;
  priceAdjustment: number;
  sku?: string;
  stockQuantity?: number;
  trackStock: boolean;
  isActive: boolean;
  sortOrder: number;
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
