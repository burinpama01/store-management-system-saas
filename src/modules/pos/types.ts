import type { ModifierOption, ProductVariant } from "@/modules/catalog/types";

export type OrderStatus =
  | "draft"
  | "open"
  | "pending_payment"
  | "paid"
  | "refunded"
  | "voided"
  | "cancelled";

export type PaymentMethod =
  | "cash"
  | "qr_promptpay"
  | "credit_card"
  | "bank_transfer"
  | "other";

export type PaymentStatus = "pending" | "completed" | "failed" | "refunded";

export interface SelectedModifier {
  modifierGroupId: string;
  modifierGroupName: string;
  option: Pick<ModifierOption, "id" | "name" | "priceAdjustment">;
}

/** หน่วยขายแพ็คที่เลือกในตะกร้า (โหล/ลัง) — quantity คือตัวคูณสต๊อกต่อ 1 หน่วย */
export interface CartItemUnit {
  id: string;
  name: string;
  quantity: number;
}

export interface CartItem {
  key: string;
  productId: string;
  productName: string;
  categoryId: string;
  variant: Pick<ProductVariant, "id" | "name" | "priceAdjustment"> | null;
  /** null/undefined = ขายหน่วยฐาน (ชิ้น) */
  unit?: CartItemUnit | null;
  modifiers: SelectedModifier[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discount?: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountNote?: string;
  note?: string;
  /** Set when this line is a redeemed product reward (priced ฿0, validated server-side via the voucher). */
  rewardVoucherCode?: string;
}

export type DiscountType = "amount" | "percentage";

export interface Cart {
  storeId: string;
  items: CartItem[];
  subtotal: number;
  discount: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountNote?: string;
  total: number;
}

export interface SavedOrderTicket {
  id: string;
  ticketNumber: string;
  label: string;
  cart: Cart;
  tableId?: string;
  tableNumber?: string;
  customerName?: string;
  note?: string;
  buffetSessionId?: string;
  syncState?: "synced" | "local" | "sync_failed";
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  storeId: string;
  organizationId: string;
  orderNumber: string;
  status: OrderStatus;
  tableId?: string;
  tableNumber?: string;
  buffetSessionId?: string;
  cashierId: string | null;
  customerId?: string;
  couponId?: string;
  couponDiscountAmount?: number;
  loyaltyPointsEarned?: number;
  loyaltyPointsRedeemed?: number;
  loyaltyPointsBalance?: number;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  discountNote?: string;
  total: number;
  payments: Payment[];
  note?: string;
  qrOrderSource?: boolean;
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  voidedAt?: string;
  voidReason?: string;
  voidedByUserId?: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  variantId?: string;
  variantName?: string;
  unitId?: string;
  unitName?: string;
  /** ตัวคูณสต๊อกต่อ 1 หน่วยที่ขาย (1 = หน่วยฐาน, 12 = โหล) */
  unitQuantity?: number;
  modifiers: SelectedModifier[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discount?: number;
  discountType?: DiscountType;
  discountValue?: number;
  discountNote?: string;
  note?: string;
}

export interface Payment {
  id: string;
  orderId: string;
  method: PaymentMethod;
  amount: number;
  status: PaymentStatus;
  reference?: string;
  receivedAmount?: number;
  changeAmount?: number;
  processedAt: string;
  processedByUserId: string;
}

export interface CartItemKey {
  productId: string;
  variantId: string | null;
  unitId?: string | null;
  modifierOptionIds: string[];
  note?: string;
}

export function buildCartItemKey(input: CartItemKey): string {
  const modifierPart = [...input.modifierOptionIds].sort().join(",");
  const notePart = input.note?.trim().replace(/\s+/g, " ") ?? "";
  return [input.productId, input.variantId ?? "", input.unitId ?? "", modifierPart, notePart].join("|");
}
