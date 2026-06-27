export type TransactionType = "income" | "expense" | "cash_adjustment";
/** How a manual income/expense was settled. Only cash moves the cash drawer. */
export type AccountingPaymentMethod = "cash" | "transfer";

export interface AccountingCategory {
  id: string;
  storeId: string;
  organizationId: string;
  name: string;
  type: TransactionType;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  id: string;
  storeId: string;
  organizationId: string;
  type: TransactionType;
  categoryId: string;
  categoryName: string;
  amount: number;
  paymentMethod: AccountingPaymentMethod;
  note?: string;
  date: string;
  createdByUserId: string;
  orderId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashLedgerEntry {
  id: string;
  storeId: string;
  organizationId: string;
  type: "open" | "close" | "adjustment" | "pos_sale" | "expense" | "income";
  amount: number;
  balanceAfter: number;
  transactionId?: string;
  orderId?: string;
  note?: string;
  createdByUserId: string;
  createdAt: string;
}

export interface CashflowSummary {
  storeId: string;
  dateFrom: string;
  dateTo: string;
  openingBalance: number;
  totalIncome: number;
  totalExpense: number;
  netCashflow: number;
  closingBalance: number;
}

export interface DailySummary {
  date: string;
  storeId: string;
  totalSales: number;
  totalOrders: number;
  totalIncome: number;
  totalExpense: number;
  netCash: number;
}
