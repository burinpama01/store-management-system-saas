import type { Cart } from "@/modules/pos/types";

export const CUSTOMER_DISPLAY_CHANNEL = "storeos:grocery-pos:customer-display";

export type CustomerDisplayStatus = "idle" | "scanning" | "checkout" | "paid";

export interface CustomerDisplayPayment {
  method: "qr_promptpay";
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
    payment.method === "qr_promptpay" &&
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
