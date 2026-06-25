import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const exists = (path: string) => existsSync(join(root, path));

describe("QR kitchen stations", () => {
  it("adds store-scoped kitchen station schema and snapshots station routing on QR order items", () => {
    const migrationPath = "supabase/migrations/20260623193000_qr_kitchen_stations.sql";
    expect(exists(migrationPath)).toBe(true);

    const migration = read(migrationPath);
    expect(migration).toContain("create table if not exists kitchen_stations");
    expect(migration).toContain("alter table products");
    expect(migration).toContain("add column if not exists kitchen_station_id uuid");
    expect(migration).toContain("alter table order_items");
    expect(migration).toContain("add column if not exists kitchen_station_name text");
    expect(migration).toContain("products_kitchen_station_store_fk");
    expect(migration).toContain("unique (id, store_id)");
    expect(migration).toContain("foreign key (kitchen_station_id, store_id)");
    expect(migration).toContain("references kitchen_stations(id, store_id)");
    expect(migration).toContain("kitchen_stations enable row level security");
    expect(migration).toContain("auth_user_has_permission(organization_id, store_id, 'settings.manage_store')");
    expect(migration).toContain("create or replace function set_order_item_kitchen_station");
    expect(migration).toContain("create trigger set_order_item_kitchen_station_before_insert");
    expect(migration).toContain("for each row execute function set_updated_at()");
    expect(migration).toMatch(/select\s+kitchen_stations\.id,\s+kitchen_stations\.name\s+into\s+new\.kitchen_station_id[\s\S]*/);
    expect(migration).toMatch(/join kitchen_stations\s+on kitchen_stations\.id = products\.kitchen_station_id[\s\S]*kitchen_stations\.is_active = true/);
    expect(migration).toContain("kitchen_station_id = kitchen_stations.id");
    expect(migration).toContain("kitchen_stations.name");
    expect(migration).toContain("kitchen_station_name");
  });

  it("exposes station repository APIs and maps station info into QR order lines", () => {
    const stationRepo = read("src/modules/qr-ordering/kitchen-stations.ts");
    expect(stationRepo).toContain("export interface KitchenStation");
    expect(stationRepo).toContain("export async function listKitchenStations");
    expect(stationRepo).toContain("export async function saveKitchenStation");
    expect(stationRepo).toContain("export async function deleteKitchenStation");
    expect(stationRepo).toContain("export async function assignProductKitchenStation");
    expect(stationRepo).toContain(".eq(\"store_id\", storeId)");
    expect(stationRepo).toContain("Inactive kitchen station cannot be edited");
    expect(stationRepo).toContain(".eq(\"is_active\", true)");

    const types = read("src/modules/qr-ordering/types.ts");
    expect(types).toContain("kitchenStationId?: string");
    expect(types).toContain("kitchenStationName?: string");

    const repo = read("src/modules/qr-ordering/repository.ts");
    expect(repo).toContain("kitchenStationId: row.kitchen_station_id");
    expect(repo).toContain("kitchenStationName: row.kitchen_station_name");
  });

  it("adds a settings UI for station CRUD and product routing", () => {
    expect(exists("src/app/(dashboard)/settings/kitchen/page.tsx")).toBe(true);
    expect(exists("src/app/(dashboard)/settings/kitchen/actions.ts")).toBe(true);
    expect(exists("src/app/(dashboard)/settings/kitchen/KitchenStationsManager.tsx")).toBe(true);

    const layout = read("src/app/(dashboard)/settings/layout.tsx");
    expect(layout).toContain("{ href: \"/settings/kitchen\", label: \"Kitchen\" }");

    const page = read("src/app/(dashboard)/settings/kitchen/page.tsx");
    expect(page).toContain("listKitchenStations(ctx.storeId");
    expect(page).toContain("listProducts(ctx.storeId");
    expect(page).toContain("<KitchenStationsManager");

    const actions = read("src/app/(dashboard)/settings/kitchen/actions.ts");
    expect(actions).toContain("requirePermission(\"settings.manage_store\")");
    expect(actions).toContain("saveKitchenStation");
    expect(actions).toContain("assignProductKitchenStation");
    expect(actions).toContain("isActive: true");

    const manager = read("src/app/(dashboard)/settings/kitchen/KitchenStationsManager.tsx");
    expect(manager).toContain("saveStationAction");
    expect(manager).toContain("deleteStationAction");
    expect(manager).toContain("assignProductStationAction");
    expect(manager).toContain("Unassigned");
    expect(manager).not.toContain("name=\"isActive\"");
  });

  it("lets staff filter QR kitchen board by station", () => {
    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain("selectedStation");
    expect(board).toContain("stationOptions");
    expect(board).toContain("filteredActiveOrders");
    expect(board).toContain("visibleItems");
    expect(board).toContain("Kitchen station");
    expect(board).toContain("order.items.some");
    expect(board).toContain("itemMatchesStation(item, selectedStation)");
    expect(board).toContain("const canAdvanceOrder = selectedStation === \"all\"");
    expect(board).toContain("เลือก All stations เพื่อเปลี่ยนสถานะทั้งออร์เดอร์");
    expect(board).toContain("item.kitchenStationId");
  });
});
