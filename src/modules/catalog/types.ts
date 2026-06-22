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
  name: string;
  description?: string;
  barcode?: string;
  imageUrl?: string;
  basePrice: number;
  isActive: boolean;
  availableForPos: boolean;
  availableForQr: boolean;
  sortOrder: number;
  variants: ProductVariant[];
  modifierGroups: ModifierGroup[];
  createdAt: string;
  updatedAt: string;
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
