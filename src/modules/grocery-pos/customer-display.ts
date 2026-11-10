import type { Cart } from "@/modules/pos/types";

export const CUSTOMER_DISPLAY_CHANNEL = "storeos:grocery-pos:customer-display";

export type CustomerDisplayStatus = "idle" | "scanning" | "checkout" | "paid";

export interface CustomerDisplayPayment {
  /** QR payload (PromptPay or TrueMoney EMV). Field name kept for BroadcastChannel compat. */
  method: "qr_promptpay" | "truemoney";
  amount: number;
  promptPayPayload: string;
}

export interface CustomerDisplayCustomer {
  name?: string;
  pointsEarned?: number;
  pointsBalance?: number;
}

export interface CustomerDisplayInput {
  status?: CustomerDisplayStatus;
  customerName?: string;
  customer?: CustomerDisplayCustomer | null;
  payment?: CustomerDisplayPayment | null;
}

export interface CustomerDisplaySnapshot {
  channel: typeof CUSTOMER_DISPLAY_CHANNEL;
  status: CustomerDisplayStatus;
  customerName?: string;
  customer?: CustomerDisplayCustomer;
  items: Array<{
    name: string;
    variantName?: string;
    options: string[];
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  subtotal: number;
  discount: number;
  total: number;
  payment?: CustomerDisplayPayment;
  updatedAt: string;
}

export function buildCustomerDisplaySnapshot(
  cart: Cart,
  input: CustomerDisplayInput = {},
): CustomerDisplaySnapshot {
  const customer = buildCustomerDisplayCustomer(input);

  return {
    channel: CUSTOMER_DISPLAY_CHANNEL,
    status: input.status ?? (cart.items.length > 0 ? "scanning" : "idle"),
    customerName: customer?.name,
    customer,
    items: cart.items.map((item) => ({
      name: item.productName,
      variantName: item.variant?.name,
      options: item.modifiers.map((modifier) => `${modifier.modifierGroupName}: ${modifier.option.name}`),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
    })),
    subtotal: cart.subtotal,
    discount: cart.discount,
    total: cart.total,
    payment: isValidCustomerDisplayPayment(input.payment) ? input.payment : undefined,
    updatedAt: new Date().toISOString(),
  };
}

function buildCustomerDisplayCustomer(input: CustomerDisplayInput): CustomerDisplayCustomer | undefined {
  const name = input.customer?.name?.trim() || input.customerName?.trim() || undefined;
  const pointsEarned = normalizeOptionalNumber(input.customer?.pointsEarned);
  const pointsBalance = normalizeOptionalNumber(input.customer?.pointsBalance);
  if (!name && pointsEarned === undefined && pointsBalance === undefined) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(pointsEarned !== undefined ? { pointsEarned } : {}),
    ...(pointsBalance !== undefined ? { pointsBalance } : {}),
  };
}

function normalizeOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isValidCustomerDisplayCustomer(value: unknown): value is CustomerDisplayCustomer {
  if (!value || typeof value !== "object") return false;
  const customer = value as Partial<CustomerDisplayCustomer>;
  const hasName = typeof customer.name === "string" && customer.name.trim().length > 0;
  const hasPointsEarned = typeof customer.pointsEarned === "number" && Number.isFinite(customer.pointsEarned);
  const hasPointsBalance = typeof customer.pointsBalance === "number" && Number.isFinite(customer.pointsBalance);
  return (
    (customer.name === undefined || hasName) &&
    (customer.pointsEarned === undefined || hasPointsEarned) &&
    (customer.pointsBalance === undefined || hasPointsBalance) &&
    (hasName || hasPointsEarned || hasPointsBalance)
  );
}

function isValidCustomerDisplayPayment(value: unknown): value is CustomerDisplayPayment {
  if (!value || typeof value !== "object") return false;
  const payment = value as Partial<CustomerDisplayPayment>;
  return (
    (payment.method === "qr_promptpay" || payment.method === "truemoney") &&
    typeof payment.amount === "number" &&
    Number.isFinite(payment.amount) &&
    payment.amount > 0 &&
    typeof payment.promptPayPayload === "string" &&
    payment.promptPayPayload.trim().length > 0
  );
}

function isValidCustomerDisplayItem(value: unknown): value is CustomerDisplaySnapshot["items"][number] {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CustomerDisplaySnapshot["items"][number]>;
  return (
    typeof item.name === "string" &&
    item.name.trim().length > 0 &&
    (item.variantName === undefined || typeof item.variantName === "string") &&
    Array.isArray(item.options) &&
    item.options.every((option) => typeof option === "string" && option.trim().length > 0) &&
    typeof item.quantity === "number" &&
    Number.isFinite(item.quantity) &&
    typeof item.unitPrice === "number" &&
    Number.isFinite(item.unitPrice) &&
    typeof item.totalPrice === "number" &&
    Number.isFinite(item.totalPrice)
  );
}

export function validateCustomerDisplayMessage(value: unknown): value is CustomerDisplaySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<CustomerDisplaySnapshot>;
  return (
    snapshot.channel === CUSTOMER_DISPLAY_CHANNEL &&
    ["idle", "scanning", "checkout", "paid"].includes(String(snapshot.status)) &&
    Array.isArray(snapshot.items) &&
    snapshot.items.every(isValidCustomerDisplayItem) &&
    typeof snapshot.subtotal === "number" &&
    typeof snapshot.discount === "number" &&
    typeof snapshot.total === "number" &&
    (snapshot.customer === undefined || isValidCustomerDisplayCustomer(snapshot.customer)) &&
    (snapshot.payment === undefined || isValidCustomerDisplayPayment(snapshot.payment))
  );
}

/** เวลาที่จอลูกค้าโชว์ "ชำระเงินสำเร็จ" ก่อนปิดเอง */
export const CUSTOMER_DISPLAY_PAID_FLASH_MS = 5_000;

export interface CustomerDisplayPaidFlash {
  amount: number;
  method: CustomerDisplayPayment["method"];
  pointsEarned?: number;
}

export interface CustomerDisplayPaymentTransition {
  /** QR ที่กำลังโชว์อยู่บนจอ (ยังรอลูกค้าจ่าย) */
  pendingPayment: CustomerDisplayPayment | null;
  /** มีค่า = เพิ่งได้รับเงินจาก QR ที่โชว์อยู่ → แสดงหน้าสำเร็จ */
  paidFlash: CustomerDisplayPaidFlash | null;
}

/**
 * จอลูกค้า: ตัดสินว่า snapshot ใหม่ทำให้ QR ที่โชว์อยู่ "ได้รับเงินแล้ว" หรือไม่
 * - checkout + payment → จำ QR ที่กำลังรอจ่าย
 * - paid ขณะมี QR รอจ่าย → แสดงหน้าสำเร็จ (ครั้งเดียว — snapshot paid ซ้ำไม่เด้งใหม่)
 * - สถานะอื่น / checkout ที่ไม่มี QR → ล้าง (แคชเชียร์ยกเลิกหรือเปลี่ยนวิธีจ่าย)
 */
export function resolveCustomerDisplayPaymentTransition(
  pendingPayment: CustomerDisplayPayment | null,
  snapshot: CustomerDisplaySnapshot,
): CustomerDisplayPaymentTransition {
  if (snapshot.status === "checkout") {
    if (snapshot.payment) return { pendingPayment: snapshot.payment, paidFlash: null };
    // POS ส่ง checkout ซ้ำโดยไม่มี QR (เช่น แคชเชียร์ผูกสมาชิกหลังโชว์ QR) — ยอดเท่าเดิม = QR เดิมยังใช้ได้
    if (pendingPayment && Math.abs(snapshot.total - pendingPayment.amount) < 0.005) {
      return { pendingPayment, paidFlash: null };
    }
    return { pendingPayment: null, paidFlash: null };
  }
  if (snapshot.status === "paid" && pendingPayment) {
    const pointsEarned = snapshot.customer?.pointsEarned;
    return {
      pendingPayment: null,
      paidFlash: {
        amount: pendingPayment.amount,
        method: pendingPayment.method,
        ...(typeof pointsEarned === "number" && pointsEarned > 0 ? { pointsEarned } : {}),
      },
    };
  }
  return { pendingPayment: null, paidFlash: null };
}

export function resolveCustomerDisplayPublishCart(input: {
  liveCart: Cart;
  paidCart?: Cart | null;
  status?: CustomerDisplayStatus;
}): Cart {
  if (input.status === "paid" && input.paidCart) return input.paidCart;
  return input.liveCart;
}

export function publishCustomerDisplaySnapshot(
  cart: Cart,
  input: CustomerDisplayInput = {},
): CustomerDisplaySnapshot | null {
  const snapshot = buildCustomerDisplaySnapshot(cart, input);
  if (typeof BroadcastChannel === "undefined") return snapshot;
  const channel = new BroadcastChannel(CUSTOMER_DISPLAY_CHANNEL);
  try {
    channel.postMessage(snapshot);
  } finally {
    channel.close();
  }
  return snapshot;
}
