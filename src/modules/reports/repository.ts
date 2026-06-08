import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import type {
  SalesSummary,
  PaymentMethodSummary,
  TopProduct,
  DailySales,
  ReportData,
  DashboardData,
} from "./types";

type SalesAggregateRow = {
  order_count: number | string | null;
  revenue: number | string | null;
  avg_order_value: number | string | null;
  qr_order_count: number | string | null;
  pos_order_count: number | string | null;
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
};

type ReportOrderRow = DashboardOrderRow & {
  paid_at: string | null;
};

// PostgREST serialises .in() as a URL query param; keep batches small to stay
// well within the typical 8 KB URL limit.
const BATCH_SIZE = 200;

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

  return {
    dateFrom,
    dateTo,
    orderCount,
    revenue,
    avgOrderValue: orderCount > 0 ? round2(revenue / orderCount) : 0,
    qrOrderCount: rows.filter((row) => row.qr_order_source === true).length,
    posOrderCount: rows.filter((row) => row.qr_order_source !== true).length,
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

async function fetchPaymentsInBatches(
  orderIds: string[],
  storeId: string,
): Promise<{ method: string; amount: number }[]> {
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
  return batches.flatMap((r) => r.data ?? []);
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
      .select("id, total, qr_order_source, paid_at")
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

  const methodMap = new Map<string, PaymentMethodSummary>();
  for (const p of allPayments) {
    const existing = methodMap.get(p.method);
    if (existing) {
      existing.count += 1;
      existing.totalAmount = round2(existing.totalAmount + p.amount);
    } else {
      methodMap.set(p.method, { method: p.method, count: 1, totalAmount: p.amount });
    }
  }
  const paymentMethods = Array.from(methodMap.values()).sort(
    (a, b) => b.totalAmount - a.totalAmount,
  );

  const topProducts = aggregateTopProducts(allItems, 20);

  return { salesSummary, paymentMethods, topProducts, dailySales };
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
      .select("id, total, qr_order_source")
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
    return { todaySales, pendingOrderCount, topProductsToday: [] };
  }

  const items = await fetchOrderItemsInBatches(orderIds, storeId);
  const topProductsToday = aggregateTopProducts(items, 5);

  return { todaySales, pendingOrderCount, topProductsToday };
}
