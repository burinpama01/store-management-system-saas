import type { PassRedeemScope } from "./rules";

export interface PassPlan {
  id: string;
  storeId: string;
  saleProductId: string;
  name: string;
  credits: number;
  price: number;
  validDays: number | null;
  redeemScope: PassRedeemScope;
  terms: string;
  isActive: boolean;
  productIds: string[];
  /** ตัวเลือกเสริม/ขนาดที่รวมในแพ็ก */
  modifierOptionIds: string[];
  variantIds: string[];
  soldCount: number;
}

/** แพ็กของสมาชิกที่ยืนยันรหัสแล้ว — เฉพาะที่ยังใช้ได้ */
export interface MemberPass {
  id: string;
  planName: string;
  creditsTotal: number;
  creditsRemaining: number;
  expiresAt: string | null;
  usableHere: boolean;
  /** เมนูของสาขานี้ที่ใช้แพ็กนี้ได้ */
  productIds: string[];
  /** ตัวเลือกเสริม/ขนาดของเมนูสาขานี้ที่แพ็กครอบคลุม (ลูกค้าไม่จ่ายเพิ่ม) */
  coveredOptionIds: string[];
  coveredVariantIds: string[];
}

/** แพ็กที่ขายใน POS: สินค้าขายแพ็ก → เงื่อนไขที่ต้องแจ้งลูกค้าก่อนขาย */
export interface PassSaleProduct {
  productId: string;
  planName: string;
  credits: number;
  validDays: number | null;
  terms: string;
}
