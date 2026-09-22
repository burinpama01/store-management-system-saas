import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ from: vi.fn(), inserted: vi.fn(), deleted: vi.fn() }));
vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ from: db.from }),
}));
import { replaceKitchenStationStaffAssignments } from "@/modules/qr-ordering/kitchen-stations";

const members = [
  { user_id: "s", role: "staff", organization_id: "org", store_id: "store", joined_at: "date" },
  { user_id: "c", role: "cashier", organization_id: "org", store_id: "store", joined_at: "date" },
  { user_id: "m", role: "manager", organization_id: "org", store_id: null, joined_at: "date" },
  { user_id: "o", role: "owner", organization_id: "org", store_id: "store", joined_at: "date" },
  { user_id: "a", role: "admin", organization_id: "org", store_id: "store", joined_at: "date" },
  { user_id: "pending", role: "manager", organization_id: "org", store_id: "store", joined_at: null },
  { user_id: "other", role: "manager", organization_id: "org", store_id: "other", joined_at: "date" },
  { user_id: "foreign", role: "manager", organization_id: "foreign", store_id: null, joined_at: "date" },
];
const input = { organizationId: "org", storeId: "store", kitchenStationId: "station" };

beforeEach(() => {
  vi.clearAllMocks();
  db.from.mockImplementation((table: string) => {
    if (table === "kitchen_stations") {
      const station = { select: () => station, eq: () => station, single: async () => ({ data: { id: "station", is_active: true }, error: null }) };
      return station;
    }
    if (table === "memberships") {
      let rows = [...members];
      const query = {
        select: () => query,
        eq: (key: keyof typeof members[number], value: string) => { rows = rows.filter(r => r[key] === value); return query; },
        in: (key: keyof typeof members[number], values: string[]) => { rows = rows.filter(r => values.includes(r[key] as string)); return query; },
        or: () => { rows = rows.filter(r => r.store_id === "store" || r.store_id === null); return query; },
        not: () => { rows = rows.filter(r => r.joined_at !== null); return query; },
        then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }),
      };
      return query;
    }
    const assignments = {
      delete: () => { db.deleted(); return assignments; },
      eq: () => assignments,
      then: (resolve: (value: unknown) => void) => resolve({ error: null }),
      insert: async (rows: unknown) => { db.inserted(rows); return { error: null }; },
    };
    return assignments;
  });
});

describe("kitchen assignment membership eligibility", () => {
  it("assigns staff, cashier and manager together to one station without duplicates", async () => {
    expect(await replaceKitchenStationStaffAssignments({ ...input, userIds: ["s", "c", "m", "m"] })).toEqual({ error: null });
    expect(db.inserted).toHaveBeenCalledWith(["s", "c", "m"].map(user_id => ({
      organization_id: "org", store_id: "store", kitchen_station_id: "station", user_id,
    })));
  });
  it.each(["o", "a", "pending", "other", "foreign"])("rejects ineligible member %s before changing existing assignments", async id => {
    const result = await replaceKitchenStationStaffAssignments({ ...input, userIds: ["s", id] });
    expect(result.error).toBeTruthy();
    expect(db.deleted).not.toHaveBeenCalled();
    expect(db.inserted).not.toHaveBeenCalled();
  });
});
