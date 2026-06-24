export interface SalesSummary {
  dateFrom: string;
  dateTo: string;
  orderCount: number;
  revenue: number;
  avgOrderValue: number;
  qrOrderCount: number;
  posOrderCount: number;
}

export interface PaymentMethodSummary {
  method: string;
  count: number;
  totalAmount: number;
}

export interface TopProduct {
  productId: string;
  productName: string;
  quantitySold: number;
  revenue: number;
}

export interface DailySales {
  date: string;
  orderCount: number;
  revenue: number;
}

export interface BranchSalesSummary {
  storeId: string;
  storeName: string;
  orderCount: number;
  revenue: number;
  avgOrderValue: number;
  qrOrderCount: number;
  posOrderCount: number;
  revenueSharePercent: number;
}

export interface ReportData {
  salesSummary: SalesSummary;
  paymentMethods: PaymentMethodSummary[];
  topProducts: TopProduct[];
  dailySales: DailySales[];
}

export interface DashboardData {
  todaySales: SalesSummary;
  pendingOrderCount: number;
  paymentMethodsToday: PaymentMethodSummary[];
  topProductsToday: TopProduct[];
}
