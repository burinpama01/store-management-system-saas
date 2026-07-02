import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = () =>
  fs.readFileSync(path.join(process.cwd(), "src/modules/reports/repository.ts"), "utf8");
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("reports repository store anchors", () => {
  it("anchors payment and order item batch queries back to orders.store_id", () => {
    const repository = source();

    expect(repository).toContain("fetchPaymentsInBatches(orderIds, storeId)");
    expect(repository).toContain("fetchOrderItemsInBatches(orderIds, storeId)");
    expect(repository).toContain('select("method, amount, orders!inner(store_id)")');
    expect(repository).toContain('select("product_id, product_name, quantity, total_price, orders!inner(store_id)")');
    expect(repository).toContain('.eq("orders.store_id", storeId)');
  });

  it("uses Postgres numeric aggregates for report revenue instead of JS float sums", () => {
    const repository = source();
    const migration = read("supabase/migrations/20260601000011_report_sales_aggregates.sql");

    expect(repository).toContain('rpc("get_report_sales_summary"');
    expect(repository).toContain('rpc("get_report_daily_sales"');
    expect(repository).not.toContain("throw new Error(\"Unable to load report sales summary\")");
    expect(repository).toContain('select("id, total, qr_order_source, order_number, paid_at")');
    expect(repository).toContain("summaryResult.error");
    expect(repository).toContain("mapReportSalesFallback(reportOrders, dateFrom, dateTo)");
    expect(repository).toContain("mapDailySalesFallback(reportOrders)");
    expect(repository).toContain("mapDashboardSalesFallback(dashboardOrders, today, today)");
    expect(repository).not.toContain("throw new Error(\"Unable to load dashboard sales summary\")");
    expect(repository).toContain("throw new Error(\"Unable to load report order ids\")");
    expect(repository).toContain("throw new Error(\"Unable to load dashboard order ids\")");
    expect(repository).toContain("throw new Error(\"Unable to load report payment methods\")");
    expect(repository).toContain("throw new Error(\"Unable to load report order items\")");
    expect(repository).toContain("throw new Error(\"Unable to load dashboard pending orders\")");
    expect(repository).toContain("const nextDayExclusive = addUtcDays(dateTo, 1)");
    expect(repository).toContain('.lt("paid_at", nextDayExclusive)');
    expect(repository).toContain("const tomorrowExclusive = addUtcDays(today, 1)");
    expect(repository).toContain('.lt("paid_at", tomorrowExclusive)');
    expect(repository).not.toContain("countResult.error ? 0");
    expect(repository).not.toContain("orders.reduce((sum, o) => sum + o.total, 0)");
    expect(repository).not.toContain("existing.revenue + order.total");
    expect(migration).toContain("coalesce(sum(total), 0)");
    expect(migration).toContain("round(coalesce(avg(total), 0), 2)");
    expect(migration).toContain("group by paid_at::date");
    expect(migration).toContain("security invoker");
  });
});

function chainResult(
  result: { data?: unknown; error?: unknown; count?: number | null },
  finalMethods: string[],
) {
  const final = new Set(finalMethods);
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "gte", "lt", "in"]) {
    builder[method] = vi.fn(() => (final.has(method) ? Promise.resolve(result) : builder));
  }
  return builder;
}

function mockSupabaseClient(client: unknown) {
  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServerClient: vi.fn(async () => client),
  }));
}

function mockDashboardClient({
  summaryResult = { data: [{ order_count: 0, revenue: 0, avg_order_value: 0, qr_order_count: 0, pos_order_count: 0 }], error: null },
  paidOrdersResult = { data: [], error: null },
  pendingCountResult = { data: null, error: null, count: 0 },
  paymentsResult = { data: [], error: null },
  orderItemsResult = { data: [], error: null },
}: {
  summaryResult?: { data?: unknown; error?: unknown };
  paidOrdersResult?: { data?: unknown; error?: unknown };
  pendingCountResult?: { data?: unknown; error?: unknown; count?: number | null };
  paymentsResult?: { data?: unknown; error?: unknown };
  orderItemsResult?: { data?: unknown; error?: unknown };
}) {
  const paidOrdersQuery = chainResult(paidOrdersResult, ["lt"]);
  const pendingCountQuery = chainResult(pendingCountResult, ["in"]);
  const paymentsQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  paymentsQuery.select = vi.fn(() => paymentsQuery);
  paymentsQuery.in = vi.fn(() => paymentsQuery);
  paymentsQuery.eq = vi.fn(() =>
    paymentsQuery.eq.mock.calls.length >= 2 ? Promise.resolve(paymentsResult) : paymentsQuery,
  );
  const orderItemsQuery = chainResult(orderItemsResult, ["eq"]);
  let ordersQueryCount = 0;
  const client = {
    rpc: vi.fn(async () => summaryResult),
    from: vi.fn((table: string) => {
      if (table === "orders") {
        ordersQueryCount += 1;
        return ordersQueryCount === 1 ? paidOrdersQuery : pendingCountQuery;
      }
      if (table === "payments") {
        return paymentsQuery;
      }
      if (table === "order_items") {
        return orderItemsQuery;
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };

  mockSupabaseClient(client);
  return { client, paidOrdersQuery, pendingCountQuery, paymentsQuery, orderItemsQuery };
}

describe("reports repository dashboard behavior", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unmock("@/server/integrations/supabase/server");
  });

  it("computes dashboard sales from paid orders when the sales summary RPC fails", async () => {
    vi.resetModules();
    const { paidOrdersQuery, paymentsQuery } = mockDashboardClient({
      summaryResult: { data: null, error: { message: "missing function" } },
      paidOrdersResult: {
        data: [
          { id: "order-1", total: "10.25", qr_order_source: true, order_number: "QR-0001" },
          { id: "order-2", total: 21.5, qr_order_source: false, order_number: "POS-0001" },
          { id: "order-3", total: 40, qr_order_source: false, order_number: "JDC-AB12CD34EF56" },
        ],
        error: null,
      },
      pendingCountResult: { data: null, error: null, count: 3 },
      paymentsResult: {
        data: [
          { method: "cash", amount: "10.25" },
          { method: "qr_promptpay", amount: 21.5 },
        ],
        error: null,
      },
      orderItemsResult: {
        data: [{ product_id: "p-1", product_name: "Latte", quantity: 2, total_price: 31.75 }],
        error: null,
      },
    });

    const { getDashboardData } = await import("@/modules/reports/repository");
    const dashboard = await getDashboardData("store-1");

    expect(paidOrdersQuery.select).toHaveBeenCalledWith("id, total, qr_order_source, order_number");
    expect(paymentsQuery.select).toHaveBeenCalledWith("method, amount, orders!inner(store_id)");
    expect(dashboard.todaySales).toMatchObject({
      orderCount: 3,
      revenue: 71.75,
      avgOrderValue: 23.92,
      qrOrderCount: 1,
      posOrderCount: 1,
      deliveryOrderCount: 1,
      qrRevenue: 10.25,
      posRevenue: 21.5,
      deliveryRevenue: 40,
    });
    expect(dashboard.pendingOrderCount).toBe(3);
    expect(dashboard.topProductsToday).toEqual([
      { productId: "p-1", productName: "Latte", quantitySold: 2, revenue: 31.75 },
    ]);
    expect(dashboard.paymentMethodsToday).toEqual([
      { method: "qr_promptpay", count: 1, totalAmount: 21.5 },
      { method: "cash", count: 1, totalAmount: 10.25 },
    ]);
  });

  it("keeps dashboard order id failures fail-fast", async () => {
    vi.resetModules();
    mockDashboardClient({
      paidOrdersResult: { data: null, error: { message: "orders query failed" } },
    });

    const { getDashboardData } = await import("@/modules/reports/repository");

    await expect(getDashboardData("store-1")).rejects.toThrow(
      "Unable to load dashboard order ids",
    );
  });

  it("keeps dashboard pending count failures fail-fast", async () => {
    vi.resetModules();
    mockDashboardClient({
      pendingCountResult: { data: null, error: { message: "count query failed" }, count: null },
    });

    const { getDashboardData } = await import("@/modules/reports/repository");

    await expect(getDashboardData("store-1")).rejects.toThrow(
      "Unable to load dashboard pending orders",
    );
  });

  it("computes report sales from paid orders when aggregate RPCs fail", async () => {
    vi.resetModules();
    const paidOrdersQuery = chainResult({
      data: [
        { id: "order-1", total: "120.50", qr_order_source: true, order_number: "QR-0001", paid_at: "2026-06-05T03:00:00.000Z" },
        { id: "order-2", total: 79.5, qr_order_source: false, order_number: "POS-0001", paid_at: "2026-06-05T04:00:00.000Z" },
      ],
      error: null,
    }, ["lt"]);
    const paymentsResult = { data: [], error: null };
    const paymentsQuery: Record<string, ReturnType<typeof vi.fn>> = {};
    paymentsQuery.select = vi.fn(() => paymentsQuery);
    paymentsQuery.in = vi.fn(() => paymentsQuery);
    paymentsQuery.eq = vi.fn(() =>
      paymentsQuery.eq.mock.calls.length >= 2 ? Promise.resolve(paymentsResult) : paymentsQuery,
    );
    const itemsQuery = chainResult({ data: [], error: null }, ["eq"]);
    const client = {
      rpc: vi
        .fn()
        .mockResolvedValueOnce({ data: null, error: { message: "missing summary function" } })
        .mockResolvedValueOnce({ data: null, error: { message: "missing daily function" } }),
      from: vi.fn((table: string) => {
        if (table === "orders") return paidOrdersQuery;
        if (table === "payments") return paymentsQuery;
        if (table === "order_items") return itemsQuery;
        throw new Error(`unexpected table ${table}`);
      }),
    };
    mockSupabaseClient(client);

    const { getReportData } = await import("@/modules/reports/repository");

    const report = await getReportData("store-1", "2026-06-05", "2026-06-05");

    expect(paidOrdersQuery.select).toHaveBeenCalledWith("id, total, qr_order_source, order_number, paid_at");
    expect(report.salesSummary).toMatchObject({
      orderCount: 2,
      revenue: 200,
      avgOrderValue: 100,
      qrOrderCount: 1,
      posOrderCount: 1,
      deliveryOrderCount: 0,
    });
    expect(report.dailySales).toEqual([{ date: "2026-06-05", orderCount: 2, revenue: 200 }]);
  });
});
