import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authz: null as null | { user: { id: string }; ctx: { storeId: string; role: string }; resolved: { can: () => boolean } },
  scope: { canSeeAll: true, stationIds: [] as string[] },
  orders: [] as Array<Record<string, unknown>>,
  items: [] as Array<Record<string, unknown>>,
  orderFilters: [] as Array<[string, string, unknown]>,
  itemStationFilter: null as string[] | null,
}));

vi.mock("@/modules/auth/guards", () => ({ getOptionalResolvedCurrentPermissions: async () => state.authz }));
vi.mock("@/modules/qr-ordering/kitchen-stations", () => ({ resolveKitchenStationScope: async () => state.scope }));
vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: async () => ({
    from: (table: string) => {
      if (table === "orders") {
        const q = {
          select: () => q,
          eq: (k: string, v: unknown) => (state.orderFilters.push(["eq", k, v]), q),
          is: (k: string, v: unknown) => (state.orderFilters.push(["is", k, v]), q),
          in: (k: string, v: unknown) => (state.orderFilters.push(["in", k, v]), q),
          gte: () => q,
          order: () => q,
          limit: async () => ({ data: state.orders, error: null }),
        };
        return q;
      }
      let rows = state.items;
      const q = {
        select: () => q,
        in: (k: string, v: string[]) => {
          if (k === "kitchen_station_id") state.itemStationFilter = v;
          rows = rows.filter((r) => v.includes(r[k] as string));
          return q;
        },
        then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }),
      };
      return q;
    },
  }),
}));
import { GET } from "@/app/api/qr/pending/route";

beforeEach(() => {
  state.authz = { user: { id: "u" }, ctx: { storeId: "store", role: "cashier" }, resolved: { can: () => true } };
  state.scope = { canSeeAll: true, stationIds: [] };
  state.orders = [
    { id: "o1", order_number: "Q1", table_number: "5", created_at: "t" },
    { id: "o2", order_number: "Q2", table_number: "6", created_at: "t" },
  ];
  state.items = [
    { id: "i1", order_id: "o1", kitchen_station_id: "grill", total_price: 50 },
    { id: "i2", order_id: "o2", kitchen_station_id: "bar", total_price: 30 },
  ];
  state.orderFilters = [];
  state.itemStationFilter = null;
});

describe("GET /api/qr/pending", () => {
  it("returns new, not-yet-accepted QR kitchen orders with their items", async () => {
    const body = (await (await GET()).json()) as { orders: Array<{ id: string; items: unknown[] }> };
    expect(body.orders.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(body.orders[0].items).toHaveLength(1);
    expect(state.orderFilters).toEqual(
      expect.arrayContaining([
        ["eq", "store_id", "store"],
        ["eq", "qr_order_source", true],
        ["is", "table_bill_key", null],
        ["eq", "prep_status", "new"],
      ]),
    );
  });

  it("scopes to the member's own kitchen stations server-side", async () => {
    state.scope = { canSeeAll: false, stationIds: ["grill"] };
    const body = (await (await GET()).json()) as { orders: Array<{ id: string }> };
    expect(state.itemStationFilter).toEqual(["grill"]);
    expect(body.orders.map((o) => o.id)).toEqual(["o1"]);
  });

  it("rejects anonymous users and users without orders.manage_qr", async () => {
    state.authz = null;
    expect((await GET()).status).toBe(401);
    state.authz = { user: { id: "u" }, ctx: { storeId: "store", role: "staff" }, resolved: { can: () => false } };
    expect((await GET()).status).toBe(403);
  });
});
