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
}

/** แพ็กที่ขายใน POS: สินค้าขายแพ็ก → เงื่อนไขที่ต้องแจ้งลูกค้าก่อนขาย */
export interface PassSaleProduct {
  productId: string;
  planName: string;
  credits: number;
  validDays: number | null;
  terms: string;
}
