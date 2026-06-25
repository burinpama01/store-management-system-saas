import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const exists = (path: string) => existsSync(join(root, path));

describe("QR kitchen staff routing and notifications", () => {
  it("adds store-scoped staff assignments for kitchen stations", () => {
    const migrationPath = "supabase/migrations/20260624000001_qr_kitchen_staff_notifications.sql";
    expect(exists(migrationPath)).toBe(true);

    const migration = read(migrationPath);
    expect(migration).toContain("create table if not exists kitchen_station_staff");
    expect(migration).toContain("foreign key (kitchen_station_id, store_id)");
    expect(migration).toContain("references kitchen_stations(id, store_id)");
    expect(migration).toContain("unique (kitchen_station_id, user_id)");
    expect(migration).toContain("auth.uid() = user_id");
    expect(migration).toContain("'settings.manage_store'");
  });

  it("hardens database reads so staff cannot read orders or items outside assigned kitchens", () => {
    const migration = read("supabase/migrations/20260624000001_qr_kitchen_staff_notifications.sql");
    expect(migration).toContain("create or replace function auth_can_read_qr_order_with_kitchen_scope");
    expect(migration).toContain("create or replace function auth_can_read_qr_order_item_with_kitchen_scope");
    expect(migration).toContain("drop policy if exists \"orders: store member can read\"");
    expect(migration).toContain("drop policy if exists \"order_items: store member can read\"");
    expect(migration).toContain("auth_can_read_qr_order_with_kitchen_scope(id, organization_id, store_id, qr_order_source)");
    expect(migration).toContain("auth_can_read_qr_order_item_with_kitchen_scope(order_id, kitchen_station_id)");

    const notifier = read("src/app/(dashboard)/QrOrderGlobalNotifier.tsx");
    expect(notifier).toContain(".in(\"kitchen_station_id\", assignedKitchenStationIds)");
  });

  it("exposes repository APIs for assigning staff and scoping staff visibility", () => {
    const repo = read("src/modules/qr-ordering/kitchen-stations.ts");
    expect(repo).toContain("export interface KitchenStationStaffAssignment");
    expect(repo).toContain("export async function listKitchenStationStaffAssignments");
    expect(repo).toContain("export async function replaceKitchenStationStaffAssignments");
    expect(repo).toContain("export async function listAssignedKitchenStationIdsForUser");
    expect(repo).toContain(".eq(\"user_id\", userId)");
    expect(repo).toContain("role\", \"staff\"");

    const qrRepo = read("src/modules/qr-ordering/repository.ts");
    expect(qrRepo).toContain("export function filterQrOrdersForStations");
    expect(qrRepo).toContain("allowedStationIds.has(item.kitchenStationId");
  });

  it("restricts staff QR order board to assigned kitchens while owner can see all grouped by table", () => {
    const page = read("src/app/(dashboard)/qr-orders/page.tsx");
    expect(page).toContain("ctx.role === \"staff\"");
    expect(page).toContain("listAssignedKitchenStationIdsForUser");
    expect(page).toContain("filterQrOrdersForStations");
    expect(page).toContain("canSeeAllKitchenStations={ctx.role !== \"staff\"}");

    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain("canSeeAllKitchenStations");
    expect(board).toContain("ordersByTable");
    expect(board).toContain("itemsByStation");
    expect(board).toContain("ครัวนี้ยังไม่มีงาน");
    expect(board).toContain("เลือก All stations เพื่อเปลี่ยนสถานะทั้งออร์เดอร์");

    const actions = read("src/app/(dashboard)/qr-orders/actions.ts");
    expect(actions).toContain("ctx.role === \"staff\"");
    expect(actions).toContain("พนักงานครัวไม่สามารถเปลี่ยนสถานะทั้งออร์เดอร์");
  });

  it("requires QR-enabled menu products to have an active kitchen station", () => {
    const action = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    expect(action).toContain("kitchen_station_id");
    expect(action).toContain("activeKitchenStationIds");
    expect(action).toContain(".eq(\"is_active\", true)");
    expect(action).toContain("QR menu item must be assigned to a kitchen station");

    const publicRepo = read("src/modules/stores/public-repository.ts");
    expect(publicRepo).toContain("kitchen_station_id");
    expect(publicRepo).toContain(".not(\"kitchen_station_id\", \"is\", null)");

    const migration = read("supabase/migrations/20260624000001_qr_kitchen_staff_notifications.sql");
    expect(migration).toContain("create or replace function qr_product_has_active_kitchen_station");
    expect(migration).toContain("qr_product_has_active_kitchen_station(id, store_id)");
    expect(migration).toContain("QR order item requires an active kitchen station");
  });

  it("adds a global QR order notifier with sound, dialog navigation, auto-print toggle, and printer connection state", () => {
    expect(exists("src/app/(dashboard)/QrOrderGlobalNotifier.tsx")).toBe(true);

    const layout = read("src/app/(dashboard)/layout.tsx");
    expect(layout).toContain("<QrOrderGlobalNotifier");
    expect(layout).toContain("qrOrderingEnabled");
    expect(layout).toContain("assignedKitchenStationIds");

    const notifier = read("src/app/(dashboard)/QrOrderGlobalNotifier.tsx");
    expect(notifier).toContain("managedRealtimeSubscription");
    expect(notifier).toContain("qr_order_source");
    expect(notifier).toContain("role=\"dialog\"");
    expect(notifier).toContain("ไปหน้ารายการออเดอร์");
    expect(notifier).toContain("qrOrderAutoPrintEnabled");
    expect(notifier).toContain("isBluetoothPrinterConnected");
    expect(notifier).toContain("isUsbPrinterConnected");
    expect(notifier).toContain("printQrKitchenOrder");
  });
});
