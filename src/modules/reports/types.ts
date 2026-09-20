export interface SalesSummary {
  dateFrom: string;
  dateTo: string;
  orderCount: number;
  revenue: number;
  avgOrderValue: number;
  qrOrderCount: number;
  posOrderCount: number;
  /** ออเดอร์เดลิเวอรี (StoreOS Connect — เลขบิลขึ้นต้น JDC-) */
  deliveryOrderCount: number;
  qrRevenue: number;
  posRevenue: number;
  deliveryRevenue: number;
  /**
   * บิลรวมโต๊ะ (ออเดอร์ QR + รายการหน้าร้านของโต๊ะ รวมจ่ายบิลเดียว) — นับอยู่ในยอด QR แล้ว
   * ไม่ใช่ช่องทางแยก แค่ระบุให้เห็นว่ายอด QR มีบิลรวมกี่บิล
   */
  tableBillCount: number;
  tableBillRevenue: number;
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
  deliveryOrderCount: number;
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
