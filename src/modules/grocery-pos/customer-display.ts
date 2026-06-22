import type { Cart } from "@/modules/pos/types";

export const CUSTOMER_DISPLAY_CHANNEL = "storeos:grocery-pos:customer-display";

export type CustomerDisplayStatus = "idle" | "scanning" | "checkout" | "paid";

export interface CustomerDisplayPayment {
  method: "qr_promptpay";
  amount: number;
  promptPayPayload: string;
}

export interface CustomerDisplaySnapshot {
  channel: typeof CUSTOMER_DISPLAY_CHANNEL;
  status: CustomerDisplayStatus;
  customerName?: string;
  items: Array<{
    name: string;
    variantName?: string;
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
  input: { status?: CustomerDisplayStatus; customerName?: string; payment?: CustomerDisplayPayment | null } = {},
): CustomerDisplaySnapshot {
  return {
    channel: CUSTOMER_DISPLAY_CHANNEL,
    status: input.status ?? (cart.items.length > 0 ? "scanning" : "idle"),
    customerName: input.customerName?.trim() || undefined,
    items: cart.items.map((item) => ({
      name: item.productName,
      variantName: item.variant?.name,
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

function isValidCustomerDisplayPayment(value: unknown): value is CustomerDisplayPayment {
  if (!value || typeof value !== "object") return false;
  const payment = value as Partial<CustomerDisplayPayment>;
  return (
    payment.method === "qr_promptpay" &&
    typeof payment.amount === "number" &&
    Number.isFinite(payment.amount) &&
    payment.amount > 0 &&
    typeof payment.promptPayPayload === "string" &&
    payment.promptPayPayload.trim().length > 0
  );
}

export function validateCustomerDisplayMessage(value: unknown): value is CustomerDisplaySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<CustomerDisplaySnapshot>;
  return (
    snapshot.channel === CUSTOMER_DISPLAY_CHANNEL &&
    ["idle", "scanning", "checkout", "paid"].includes(String(snapshot.status)) &&
    Array.isArray(snapshot.items) &&
    typeof snapshot.subtotal === "number" &&
    typeof snapshot.discount === "number" &&
    typeof snapshot.total === "number" &&
    (snapshot.payment === undefined || isValidCustomerDisplayPayment(snapshot.payment))
  );
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
  input: { status?: CustomerDisplayStatus; customerName?: string; payment?: CustomerDisplayPayment | null } = {},
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
