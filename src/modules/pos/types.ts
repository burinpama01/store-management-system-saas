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

export interface CartItem {
  key: string;
  productId: string;
  productName: string;
  categoryId: string;
  variant: Pick<ProductVariant, "id" | "name" | "priceAdjustment"> | null;
  modifiers: SelectedModifier[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  note?: string;
}

export interface Cart {
  storeId: string;
  items: CartItem[];
  subtotal: number;
  discount: number;
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
  cashierId: string;
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
  modifiers: SelectedModifier[];
  quantity: number;
  unitPrice: number;
  totalPrice: number;
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
  modifierOptionIds: string[];
  note?: string;
}

export function buildCartItemKey(input: CartItemKey): string {
  const modifierPart = [...input.modifierOptionIds].sort().join(",");
  const notePart = input.note?.trim().replace(/\s+/g, " ") ?? "";
  return [input.productId, input.variantId ?? "", modifierPart, notePart].join("|");
}
