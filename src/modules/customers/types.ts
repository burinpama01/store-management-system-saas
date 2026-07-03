import type { PriceTier } from "@/modules/pos/pricing";

export interface CustomerProfile {
  id: string;
  organizationId: string;
  storeId: string;
  name: string;
  phone?: string;
  email?: string;
  /** ระดับราคาขายส่งของลูกค้า (ปลีก/ส่ง/ตัวแทน/ประจำ) */
  priceTier: PriceTier;
  loyaltyAccountId?: string;
  pointsBalance?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerSaveInput {
  id?: string | null;
  organizationId: string;
  storeId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  priceTier?: PriceTier;
  isActive?: boolean;
}
