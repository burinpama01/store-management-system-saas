import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

function chainResult(
  result: { data?: unknown; error?: unknown; count?: number | null },
  finalMethods: string[],
) {
  const final = new Set(finalMethods);
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "gte", "lt", "in", "order", "range"]) {
    builder[method] = vi.fn(() => (final.has(method) ? Promise.resolve(result) : builder));
  }
  return builder;
}

function mockSupabaseClient(client: unknown) {
  vi.doMock("@/server/integrations/supabase/server", () => ({
    createSupabaseServerClient: vi.fn(async () => client),
  }));
}

describe("enterprise branch reports", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unmock("@/server/integrations/supabase/server");
  });

  it("loads branch summaries through organization and active-store boundaries", () => {
    const repository = read("src/modules/reports/repository.ts");
    const types = read("src/modules/reports/types.ts");

    expect(types).toContain("export interface BranchSalesSummary");
    expect(repository).toContain("export async function getBranchReportData");
    expect(repository).toContain('.from("stores")');
    expect(repository).toContain('.eq("organization_id", organizationId)');
    expect(repository).toContain('.eq("is_active", true)');
    expect(repository).toContain('.from("orders")');
    expect(repository).toContain('.select("store_id, total, qr_order_source")');
    expect(repository).toContain('.eq("organization_id", organizationId)');
    expect(repository).toContain('.in("store_id", batchStoreIds)');
    expect(repository).toContain("fetchBranchStoresInPages");
    expect(repository).toContain("fetchBranchOrdersInBatches");
    expect(repository).toContain(".range(offset, offset + QUERY_PAGE_SIZE - 1)");
  });

  it("gates branch reporting behind the multiBranchReporting plan feature", () => {
    const page = read("src/app/(dashboard)/reports/page.tsx");
    const manager = read("src/app/(dashboard)/reports/ReportsManager.tsx");

    expect(page).toContain("getOrganizationBillingState");
    expect(page).toContain("canUseFeature");
    expect(page).toContain('"multiBranchReporting"');
    expect(page).toContain("branchSummaries");
    expect(page).toContain("branchReportingEnabled");
    expect(page).toContain("branchReportingUnavailableMessage");
    expect(manager).toContain("branchSummaries");
    expect(manager).toContain("BranchReportTable");
    expect(manager).toContain("รายงานแยกสาขา");
  });

  it("aggregates branch summaries by active organization stores", async () => {
    vi.resetModules();
    const storesQuery = chainResult(
      {
        data: [
          { id: "store-a", name: "A Branch" },
          { id: "store-b", name: "B Branch" },
        ],
        error: null,
      },
      ["range"],
    );
    const ordersQuery = chainResult(
      {
        data: [
          { store_id: "store-a", total: "100.50", qr_order_source: false },
          { store_id: "store-a", total: "99.50", qr_order_source: true },
          { store_id: "store-b", total: "50", qr_order_source: false },
          { store_id: "store-other", total: "999", qr_order_source: false },
        ],
        error: null,
      },
      ["range"],
    );
    const client = {
      from: vi.fn((table: string) => {
        if (table === "stores") return storesQuery;
        if (table === "orders") return ordersQuery;
        throw new Error(`unexpected table ${table}`);
      }),
    };
    mockSupabaseClient(client);

    const { getBranchReportData } = await import("@/modules/reports/repository");
    const result = await getBranchReportData("org-1", "2026-06-01", "2026-06-30");

    expect(result).toEqual([
      {
        storeId: "store-a",
        storeName: "A Branch",
        orderCount: 2,
        revenue: 200,
        avgOrderValue: 100,
        qrOrderCount: 1,
        posOrderCount: 1,
        revenueSharePercent: 80,
      },
      {
        storeId: "store-b",
        storeName: "B Branch",
        orderCount: 1,
        revenue: 50,
        avgOrderValue: 50,
        qrOrderCount: 0,
        posOrderCount: 1,
        revenueSharePercent: 20,
      },
    ]);
    expect(storesQuery.eq).toHaveBeenCalledWith("organization_id", "org-1");
    expect(storesQuery.eq).toHaveBeenCalledWith("is_active", true);
    expect(storesQuery.range).toHaveBeenCalledWith(0, 999);
    expect(ordersQuery.eq).toHaveBeenCalledWith("organization_id", "org-1");
    expect(ordersQuery.in).toHaveBeenCalledWith("store_id", ["store-a", "store-b"]);
  });

  it("paginates branch orders and chunks store ids for enterprise tenants", async () => {
    vi.resetModules();
    const stores = Array.from({ length: 201 }, (_, index) => ({
      id: `store-${index + 1}`,
      name: `Branch ${index + 1}`,
    }));
    const storesQuery = chainResult({ data: stores, error: null }, ["range"]);
    const fullPage = [
      { store_id: "store-1", total: "100", qr_order_source: false },
      ...Array.from({ length: 999 }, () => ({ store_id: "outside-batch", total: "1", qr_order_source: false })),
    ];
    const orderPages = [
      fullPage,
      [{ store_id: "store-1", total: "25", qr_order_source: true }],
      [{ store_id: "store-201", total: "50", qr_order_source: true }],
      [],
    ];
    const orderQueries: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
    const client = {
      from: vi.fn((table: string) => {
        if (table === "stores") return storesQuery;
        if (table !== "orders") throw new Error(`unexpected table ${table}`);
        const query = chainResult({ data: orderPages.shift() ?? [], error: null }, ["range"]);
        orderQueries.push(query);
        return query;
      }),
    };
    mockSupabaseClient(client);

    const { getBranchReportData } = await import("@/modules/reports/repository");
    const result = await getBranchReportData("org-1", "2026-06-01", "2026-06-30");

    expect(result.find((item) => item.storeId === "store-1")?.revenue).toBe(125);
    expect(result.find((item) => item.storeId === "store-201")?.revenue).toBe(50);
    expect(orderQueries).toHaveLength(3);
    expect(orderQueries[0].in).toHaveBeenCalledWith("store_id", stores.slice(0, 200).map((store) => store.id));
    expect(orderQueries[1].range).toHaveBeenCalledWith(1000, 1999);
    expect(orderQueries[2].in).toHaveBeenCalledWith("store_id", ["store-201"]);
  });

  it("paginates active branch stores before querying enterprise order batches", async () => {
    vi.resetModules();
    const firstStorePage = Array.from({ length: 1000 }, (_, index) => ({
      id: `store-${index + 1}`,
      name: `Branch ${index + 1}`,
    }));
    const secondStorePage = [{ id: "store-1001", name: "Branch 1001" }];
    const storePages = [firstStorePage, secondStorePage];
    const orderPages = [
      [],
      [],
      [],
      [],
      [],
      [{ store_id: "store-1001", total: "75", qr_order_source: false }],
    ];
    const storeQueries: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
    const orderQueries: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
    const client = {
      from: vi.fn((table: string) => {
        if (table === "stores") {
          const query = chainResult({ data: storePages.shift() ?? [], error: null }, ["range"]);
          storeQueries.push(query);
          return query;
        }
        if (table !== "orders") throw new Error(`unexpected table ${table}`);
        const query = chainResult({ data: orderPages.shift() ?? [], error: null }, ["range"]);
        orderQueries.push(query);
        return query;
      }),
    };
    mockSupabaseClient(client);

    const { getBranchReportData } = await import("@/modules/reports/repository");
    const result = await getBranchReportData("org-1", "2026-06-01", "2026-06-30");

    expect(storeQueries).toHaveLength(2);
    expect(storeQueries[0].range).toHaveBeenCalledWith(0, 999);
    expect(storeQueries[1].range).toHaveBeenCalledWith(1000, 1999);
    expect(result).toHaveLength(1001);
    expect(result.find((item) => item.storeId === "store-1001")).toMatchObject({
      revenue: 75,
      orderCount: 1,
    });
    expect(orderQueries).toHaveLength(6);
    expect(orderQueries[5].in).toHaveBeenCalledWith("store_id", ["store-1001"]);
  });
});
