export type CashSessionStatus = "open" | "closed";

export interface CashSession {
  id: string;
  organizationId: string;
  storeId: string;
  status: CashSessionStatus;
  openingFloat: number;
  openedByUserId: string;
  openedAt: string;
  openNote?: string;
  closingCount?: number;
  cashSales?: number;
  expectedCash?: number;
  variance?: number;
  closedByUserId?: string;
  closedAt?: string;
  closeNote?: string;
  createdAt: string;
  updatedAt: string;
}
