import type { Cart } from "@/modules/pos/types";

export const CUSTOMER_DISPLAY_CHANNEL = "storeos:grocery-pos:customer-display";

export type CustomerDisplayStatus = "idle" | "scanning" | "checkout" | "paid";

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
  updatedAt: string;
}

export function buildCustomerDisplaySnapshot(
  cart: Cart,
  input: { status?: CustomerDisplayStatus; customerName?: string } = {},
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
    updatedAt: new Date().toISOString(),
  };
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
    typeof snapshot.total === "number"
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
  input: { status?: CustomerDisplayStatus; customerName?: string } = {},
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
