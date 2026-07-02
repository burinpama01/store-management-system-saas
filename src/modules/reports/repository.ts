import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type {
  SalesSummary,
  PaymentMethodSummary,
  TopProduct,
  DailySales,
  ReportData,
  DashboardData,
  BranchSalesSummary,
} from "./types";

type SalesAggregateRow = {
  order_count: number | string | null;
  revenue: number | string | null;
  avg_order_value: number | string | null;
  qr_order_count: number | string | null;
  pos_order_count: number | string | null;
  delivery_order_count: number | string | null;
  qr_revenue: number | string | null;
  pos_revenue: number | string | null;
  delivery_revenue: number | string | null;
};

type DailySalesAggregateRow = {
  date: string;
  order_count: number | string | null;
  revenue: number | string | null;
};

type DashboardOrderRow = {
  id: string;
  total: number | string | null;
  qr_order_source: boolean | null;
  order_number: string | null;
};

type ReportOrderRow = DashboardOrderRow & {
  paid_at: string | null;
};

type PaymentRow = {
  method: string;
  amount: number | string | null;
};

type BranchStoreRow = {
  id: string;
  name: string;
};

type BranchOrderRow = {
  store_id: string;
  total: number | string | null;
  qr_order_source: boolean | null;
  order_number: string | null;
};

// PostgREST serialises .in() as a URL query param; keep batches small to stay
// well within the typical 8 KB URL limit.
const BATCH_SIZE = 200;
const QUERY_PAGE_SIZE = 1000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
}

function toNumber(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

type SalesChannel = "qr" | "delivery" | "pos";

/** ช่องทางขายของออเดอร์: QR (qr_order_source) / เดลิเวอรี (เลขบิล JDC-) / POS */
function orderChannel(row: { qr_order_source: boolean | null; order_number: string | null }): SalesChannel {
  if (row.qr_order_source === true) return "qr";
  if (row.order_number?.startsWith("JDC-")) return "delivery";
  return "pos";
}

function mapSalesSummary(
  row: SalesAggregateRow | null | undefined,
  dateFrom: string,
  dateTo: string,
): SalesSummary {
  return {
    dateFrom,
    dateTo,
    orderCount: toNumber(row?.order_count),
    revenue: toNumber(row?.revenue),
    avgOrderValue: toNumber(row?.avg_order_value),
    qrOrderCount: toNumber(row?.qr_order_count),
    posOrderCount: toNumber(row?.pos_order_count),
    deliveryOrderCount: toNumber(row?.delivery_order_count),
    qrRevenue: toNumber(row?.qr_revenue),
    posRevenue: toNumber(row?.pos_revenue),
    deliveryRevenue: toNumber(row?.delivery_revenue),
  };
}

function mapDailySales(rows: DailySalesAggregateRow[] | null | undefined): DailySales[] {
  return (rows ?? []).map((row) => ({
    date: row.date,
    orderCount: toNumber(row.order_count),
    revenue: toNumber(row.revenue),
  }));
}

function mapDashboardSalesFallback(
  rows: DashboardOrderRow[],
  dateFrom: string,
  dateTo: string,
): SalesSummary {
  const revenue = round2(rows.reduce((sum, row) => sum + toNumber(row.total), 0));
  const orderCount = rows.length;

  const counts: Record<SalesChannel, number> = { qr: 0, delivery: 0, pos: 0 };
  const revenues: Record<SalesChannel, number> = { qr: 0, delivery: 0, pos: 0 };
  for (const row of rows) {
    const channel = orderChannel(row);
    counts[channel] += 1;
    revenues[channel] = round2(revenues[channel] + toNumber(row.total));
  }

  return {
    dateFrom,
    dateTo,
    orderCount,
    revenue,
    avgOrderValue: orderCount > 0 ? round2(revenue / orderCount) : 0,
    qrOrderCount: counts.qr,
    posOrderCount: counts.pos,
    deliveryOrderCount: counts.delivery,
    qrRevenue: revenues.qr,
    posRevenue: revenues.pos,
    deliveryRevenue: revenues.delivery,
  };
}

function mapReportSalesFallback(
  rows: ReportOrderRow[],
  dateFrom: string,
  dateTo: string,
): SalesSummary {
  return mapDashboardSalesFallback(rows, dateFrom, dateTo);
}

function mapDailySalesFallback(rows: ReportOrderRow[]): DailySales[] {
  const byDate = new Map<string, { orderCount: number; revenue: number }>();
  for (const row of rows) {
    const date = row.paid_at?.slice(0, 10);
    if (!date) continue;
    const existing = byDate.get(date) ?? { orderCount: 0, revenue: 0 };
    existing.orderCount += 1;
    existing.revenue = round2(existing.revenue + toNumber(row.total));
    byDate.set(date, existing);
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, ...value }));
}

function aggregateTopProducts(
  items: { product_id: string; product_name: string; quantity: number; total_price: number }[],
  limit: number,
): TopProduct[] {
  const map = new Map<string, TopProduct>();
  for (const item of items) {
    const existing = map.get(item.product_id);
    if (existing) {
      existing.quantitySold += item.quantity;
      existing.revenue = round2(existing.revenue + item.total_price);
    } else {
      map.set(item.product_id, {
        productId: item.product_id,
        productName: item.product_name,
        quantitySold: item.quantity,
        revenue: item.total_price,
      });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

function aggregatePaymentMethods(payments: PaymentRow[]): PaymentMethodSummary[] {
  const methodMap = new Map<string, PaymentMethodSummary>();
  for (const p of payments) {
    const amount = toNumber(p.amount);
    const existing = methodMap.get(p.method);
    if (existing) {
      existing.count += 1;
      existing.totalAmount = round2(existing.totalAmount + amount);
    } else {
      methodMap.set(p.method, { method: p.method, count: 1, totalAmount: round2(amount) });
    }
  }
  return Array.from(methodMap.values()).sort((a, b) => b.totalAmount - a.totalAmount);
}

async function fetchPaymentsInBatches(
  orderIds: string[],
  storeId: string,
): Promise<PaymentRow[]> {
  const supabase = await createSupabaseServerClient();
  const chunks: string[][] = [];
  for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
    chunks.push(orderIds.slice(i, i + BATCH_SIZE));
  }
  const batches = await Promise.all(
    chunks.map((chunk) =>
      supabase
        .from("payments")
        .select("method, amount, orders!inner(store_id)")
        .in("order_id", chunk)
        .eq("orders.store_id", storeId)
        .eq("status", "completed"),
    ),
  );
  if (batches.some((r) => r.error)) {
    throw new Error("Unable to load report payment methods");
  }
  return batches.flatMap((r) => r.data ?? []) as PaymentRow[];
}

async function fetchOrderItemsInBatches(
  orderIds: string[],
  storeId: string,
): Promise<{ product_id: string; product_name: string; quantity: number; total_price: number }[]> {
  const supabase = await createSupabaseServerClient();
  const chunks: string[][] = [];
  for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
    chunks.push(orderIds.slice(i, i + BATCH_SIZE));
  }
  const batches = await Promise.all(
    chunks.map((chunk) =>
      supabase
        .from("order_items")
        .select("product_id, product_name, quantity, total_price, orders!inner(store_id)")
        .in("order_id", chunk)
        .eq("orders.store_id", storeId),
    ),
  );
  if (batches.some((r) => r.error)) {
    throw new Error("Unable to load report order items");
  }
  return batches.flatMap((r) => r.data ?? []);
}

async function fetchBranchStoresInPages(organizationId: string): Promise<BranchStoreRow[]> {
  const supabase = await createSupabaseServerClient();
  const stores: BranchStoreRow[] = [];
  for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
    const result = await supabase
      .from("stores")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("name")
      .range(offset, offset + QUERY_PAGE_SIZE - 1);
    if (result.error) {
      throw new Error("Unable to load branch stores");
    }
    const rows = (result.data ?? []) as BranchStoreRow[];
    stores.push(...rows);
    if (rows.length < QUERY_PAGE_SIZE) break;
  }
  return stores;
}

async function fetchBranchOrdersInBatches(
  storeIds: string[],
  organizationId: string,
  dateFrom: string,
  nextDayExclusive: string,
): Promise<BranchOrderRow[]> {
  const supabase = await createSupabaseServerClient();
  const orders: BranchOrderRow[] = [];
  for (let index = 0; index < storeIds.length; index += BATCH_SIZE) {
    const batchStoreIds = storeIds.slice(index, index + BATCH_SIZE);
    for (let offset = 0; ; offset += QUERY_PAGE_SIZE) {
      const result = await supabase
        .from("orders")
        .select("store_id, total, qr_order_source, order_number")
        .eq("organization_id", organizationId)
        .in("store_id", batchStoreIds)
        .eq("status", "paid")
        .gte("paid_at", dateFrom)
        .lt("paid_at", nextDayExclusive)
        .range(offset, offset + QUERY_PAGE_SIZE - 1);
      if (result.error) {
        throw new Error("Unable to load branch sales summary");
      }
      const rows = (result.data ?? []) as BranchOrderRow[];
      orders.push(...rows);
      if (rows.length < QUERY_PAGE_SIZE) break;
    }
  }
  return orders;
}

export async function getReportData(
  storeId: string,
  dateFrom: string,
  dateTo: string,
): Promise<ReportData> {
  const supabase = await createSupabaseServerClient();
  const nextDayExclusive = addUtcDays(dateTo, 1);

  const [summaryResult, dailyResult, orderIdsResult] = await Promise.all([
    supabase.rpc("get_report_sales_summary", {
      p_store_id: storeId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    }),
    supabase.rpc("get_report_daily_sales", {
      p_store_id: storeId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
    }),
    supabase
      .from("orders")
      .select("id, total, qr_order_source, order_number, paid_at")
      .eq("store_id", storeId)
      .eq("status", "paid")
      .gte("paid_at", dateFrom)
      .lt("paid_at", nextDayExclusive),
  ]);

  const reportOrders = (orderIdsResult.data ?? []) as ReportOrderRow[];
  const orderIds = reportOrders.map((o) => o.id);

  if (orderIdsResult.error) {
    throw new Error("Unable to load report order ids");
  }

  const salesSummary = summaryResult.error
    ? mapReportSalesFallback(reportOrders, dateFrom, dateTo)
    : mapSalesSummary(summaryResult.data?.[0] as SalesAggregateRow | undefined, dateFrom, dateTo);
  const dailySales = dailyResult.error
    ? mapDailySalesFallback(reportOrders)
    : mapDailySales(dailyResult.data as DailySalesAggregateRow[] | null | undefined);

  if (orderIds.length === 0) {
    return { salesSummary, paymentMethods: [], topProducts: [], dailySales };
  }

  const [allPayments, allItems] = await Promise.all([
    fetchPaymentsInBatches(orderIds, storeId),
    fetchOrderItemsInBatches(orderIds, storeId),
  ]);

  const paymentMethods = aggregatePaymentMethods(allPayments);
  const topProducts = aggregateTopProducts(allItems, 20);

  return { salesSummary, paymentMethods, topProducts, dailySales };
}

export async function getBranchReportData(
  organizationId: string,
  dateFrom: string,
  dateTo: string,
): Promise<BranchSalesSummary[]> {
  const nextDayExclusive = addUtcDays(dateTo, 1);

  const stores = await fetchBranchStoresInPages(organizationId);
  const storeIds = stores.map((store) => store.id);
  if (storeIds.length === 0) return [];

  const branchOrders = await fetchBranchOrdersInBatches(
    storeIds,
    organizationId,
    dateFrom,
    nextDayExclusive,
  );

  const summaries = new Map<string, BranchSalesSummary>();
  for (const store of stores) {
    summaries.set(store.id, {
      storeId: store.id,
      storeName: store.name,
      orderCount: 0,
      revenue: 0,
      avgOrderValue: 0,
      qrOrderCount: 0,
      posOrderCount: 0,
      deliveryOrderCount: 0,
      revenueSharePercent: 0,
    });
  }

  for (const order of branchOrders) {
    const summary = summaries.get(order.store_id);
    if (!summary) continue;
    summary.orderCount += 1;
    summary.revenue = round2(summary.revenue + toNumber(order.total));
    const channel = orderChannel(order);
    if (channel === "qr") {
      summary.qrOrderCount += 1;
    } else if (channel === "delivery") {
      summary.deliveryOrderCount += 1;
    } else {
      summary.posOrderCount += 1;
    }
  }

  const totalRevenue = round2(Array.from(summaries.values()).reduce((sum, summary) => sum + summary.revenue, 0));
  return Array.from(summaries.values())
    .map((summary) => ({
      ...summary,
      avgOrderValue: summary.orderCount > 0 ? round2(summary.revenue / summary.orderCount) : 0,
      revenueSharePercent: totalRevenue > 0 ? round2((summary.revenue / totalRevenue) * 100) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue || a.storeName.localeCompare(b.storeName, "th"));
}

export async function getDashboardData(storeId: string): Promise<DashboardData> {
  // today uses UTC date — orders near midnight Bangkok (UTC+7) may appear on the adjacent day.
  // See ISSUE-059 for planned timezone-aware fix.
  const today = new Date().toISOString().split("T")[0];
  const supabase = await createSupabaseServerClient();
  const tomorrowExclusive = addUtcDays(today, 1);

  const [summaryResult, orderIdsResult, countResult] = await Promise.all([
    supabase.rpc("get_report_sales_summary", {
      p_store_id: storeId,
      p_date_from: today,
      p_date_to: today,
    }),
    supabase
      .from("orders")
      .select("id, total, qr_order_source, order_number")
      .eq("store_id", storeId)
      .eq("status", "paid")
      .gte("paid_at", today)
      .lt("paid_at", tomorrowExclusive),
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .in("status", ["open", "pending_payment"]),
  ]);

  const dashboardOrders = (orderIdsResult.data ?? []) as DashboardOrderRow[];
  const orderIds = dashboardOrders.map((o) => o.id);
  if (orderIdsResult.error) {
    throw new Error("Unable to load dashboard order ids");
  }
  if (countResult.error) {
    throw new Error("Unable to load dashboard pending orders");
  }
  const todaySales = summaryResult.error
    ? mapDashboardSalesFallback(dashboardOrders, today, today)
    : mapSalesSummary(summaryResult.data?.[0] as SalesAggregateRow | undefined, today, today);

  const pendingOrderCount = countResult.count ?? 0;

  if (orderIds.length === 0) {
    return { todaySales, pendingOrderCount, paymentMethodsToday: [], topProductsToday: [] };
  }

  const [allPayments, items] = await Promise.all([
    fetchPaymentsInBatches(orderIds, storeId),
    fetchOrderItemsInBatches(orderIds, storeId),
  ]);
  const paymentMethodsToday = aggregatePaymentMethods(allPayments);
  const topProductsToday = aggregateTopProducts(items, 5);

  return { todaySales, pendingOrderCount, paymentMethodsToday, topProductsToday };
}
