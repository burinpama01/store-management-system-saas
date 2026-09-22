import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ assigned: {} as Record<string, string[]>, fail: false }));
vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    from: () => {
      let userId = "";
      const query = {
        select: () => query,
        eq: (key: string, value: string) => {
          if (key === "user_id") userId = value;
          return query;
        },
        then: (resolve: (value: unknown) => void) =>
          resolve(
            db.fail
              ? { data: null, error: { message: "boom", code: "XX000" } }
              : { data: (db.assigned[userId] ?? []).map((id) => ({ kitchen_station_id: id })), error: null },
          ),
      };
      return query;
    },
  }),
}));
import { resolveKitchenStationScope } from "@/modules/qr-ordering/kitchen-stations";

beforeEach(() => {
  db.assigned = { s: ["grill"], c: ["bar"], m: ["grill", "bar"] };
  db.fail = false;
});

describe("kitchen station scope", () => {
  it("scopes every assigned member (staff, cashier, manager) to their own stations", async () => {
    await expect(resolveKitchenStationScope("store", "s", "staff")).resolves.toEqual({ canSeeAll: false, stationIds: ["grill"] });
    await expect(resolveKitchenStationScope("store", "c", "cashier")).resolves.toEqual({ canSeeAll: false, stationIds: ["bar"] });
    await expect(resolveKitchenStationScope("store", "m", "manager")).resolves.toEqual({ canSeeAll: false, stationIds: ["grill", "bar"] });
  });

  it("unassigned staff sees nothing; unassigned cashier/manager and owner see all", async () => {
    await expect(resolveKitchenStationScope("store", "x", "staff")).resolves.toEqual({ canSeeAll: false, stationIds: [] });
    await expect(resolveKitchenStationScope("store", "x", "cashier")).resolves.toEqual({ canSeeAll: true, stationIds: [] });
    await expect(resolveKitchenStationScope("store", "x", "manager")).resolves.toEqual({ canSeeAll: true, stationIds: [] });
    await expect(resolveKitchenStationScope("store", "c", "owner")).resolves.toEqual({ canSeeAll: true, stationIds: [] });
  });

  it("a failed lookup keeps staff locked down and leaves cashier/manager unrestricted", async () => {
    db.fail = true;
    await expect(resolveKitchenStationScope("store", "s", "staff")).resolves.toEqual({ canSeeAll: false, stationIds: [] });
    await expect(resolveKitchenStationScope("store", "c", "cashier")).resolves.toEqual({ canSeeAll: true, stationIds: [] });
  });
});
