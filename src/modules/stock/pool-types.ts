export type StockAdjustment =
  | { mode: "receive"; quantity: number; reason?: string }
  | { mode: "set_balance"; quantity: number; reason: string };

export type PoolDemandInput = {
  poolId: string;
  orderQuantity: number;
  unitsPerItem: number;
};
