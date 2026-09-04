export type StockAlertSeverity = "low" | "out";

export interface StockAlert {
  productId: string;
  variantId: string;
  productName: string;
  variantName: string;
  stockQuantity: number;
  threshold: number;
  severity: StockAlertSeverity;
}

export type StockPoolAdjustmentMode = "receive" | "set_balance";

export interface StockPoolAdjustmentInput {
  poolId: string;
  storeId: string;
  mode: StockPoolAdjustmentMode;
  quantity: number;
  reason: string | null;
}
