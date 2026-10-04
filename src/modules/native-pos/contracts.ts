/** Public mobile DTOs. No server imports or credentials belong in this module. */
export interface NativeChoice { id: string; name: string; priceSatang: number }
export interface NativeProduct {
  id: string; name: string; categoryId: string; priceSatang: number;
  available: boolean; variants: NativeChoice[];
  groups: { id: string; name: string; min: number; max: number; options: NativeChoice[] }[];
}
export interface NativeLine {
  key: string; productId: string; name: string; quantity: number; unitSatang: number;
  variantId: string | null; optionIds: string[]; note: string;
  choiceLabel?: string;
}
export interface NativeOrder {
  id: string; number: string; status: string; totalSatang: number;
  createdAt: string; lines: NativeLine[];
}
export type NativeDeliveryStatus = 'received' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled';
export interface NativeDeliveryOrder extends NativeOrder {
  externalId: string; internalOrderId: string | null;
  status: NativeDeliveryStatus;
}
export interface NativeBootstrap {
  userId: string;
  stores: { id: string; name: string }[];
  store: { id: string; name: string } | null;
  products: NativeProduct[];
  categories: { id: string; name: string }[];
  permissions: { sell: boolean; delivery: boolean };
}
export interface NativeCheckoutInput {
  operationId: string;
  expectedTotalSatang: number;
  lines: Pick<NativeLine, 'productId' | 'variantId' | 'optionIds' | 'quantity' | 'note'>[];
  method: 'cash' | 'bank_transfer';
  receivedSatang: number;
}
export interface NativeCheckoutResult {
  outcome?: 'paid' | 'closed';
  closedStatus?: 'cancelled' | 'voided' | 'refunded';
  order: NativeOrder | null;
  error: string | null;
  orderId?: string | null;
  failedStage?: string;
}
