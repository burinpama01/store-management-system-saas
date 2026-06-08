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
