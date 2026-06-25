import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildGroceryCatalogVersion,
  buildGroceryOfflineOrderOperation,
  createGroceryPosSyncRunner,
  type GroceryOfflineOrderOperation,
} from "@/modules/grocery-pos/offline-sync";
import type { Cart } from "@/modules/pos/types";

const cart: Cart = {
  storeId: "store-1",
  items: [
    {
      key: "milk",
      productId: "product-1",
      productName: "Milk",
      categoryId: "cat-1",
      variant: null,
      modifiers: [],
      quantity: 2,
      unitPrice: 35,
      totalPrice: 70,
    },
  ],
  subtotal: 70,
  discount: 0,
  total: 70,
};

function operation(overrides: Partial<GroceryOfflineOrderOperation> = {}): GroceryOfflineOrderOperation {
  return {
    operationId: "op-1",
    operationType: "create_order",
    status: "pending",
    storeId: "store-1",
    deviceId: "device-1",
    idempotencyKey: "grocery-offline:store-1:device-1:op-1",
    catalogVersion: "catalog-v1",
    createdAt: "2026-06-21T03:00:00.000Z",
    updatedAt: "2026-06-21T03:00:00.000Z",
    payload: {
      cart,
      customerId: null,
      couponCode: null,
      clientCouponDiscountAmount: 0,
      note: "Grocery POS offline",
    },
    ...overrides,
  };
}

describe("grocery POS offline sync", () => {
  it("builds deterministic device-scoped operation and idempotency keys", () => {
    const result = buildGroceryOfflineOrderOperation({
      storeId: "store-1",
      deviceId: "device-1",
      operationId: "op-1",
      catalogVersion: "catalog-v1",
      createdAt: new Date("2026-06-21T03:00:00.000Z"),
      cart,
      customerId: null,
      couponCode: null,
      clientCouponDiscountAmount: 0,
    });

    expect(result).toMatchObject({
      operationId: "op-1",
      operationType: "create_order",
      status: "pending",
      storeId: "store-1",
      deviceId: "device-1",
      idempotencyKey: "grocery-offline:store-1:device-1:op-1",
      catalogVersion: "catalog-v1",
      payload: {
        cart,
        customerId: null,
        couponCode: null,
        clientCouponDiscountAmount: 0,
      },
    });
  });

  it("sync runner skips offline state and marks successful replay as synced", async () => {
    const pending = operation();
    const postOperation = vi.fn(async () => ({ ok: true as const, orderId: "order-1" }));
    const markSynced = vi.fn(async () => undefined);
    const markFailed = vi.fn(async () => undefined);
    const runner = createGroceryPosSyncRunner({
      isOnline: () => false,
      listPending: vi.fn(async () => [pending]),
      postOperation,
      markSynced,
      markFailed,
    });

    await expect(runner()).resolves.toEqual({ attempted: 0, synced: 0, failed: 0, skipped: true });
    expect(postOperation).not.toHaveBeenCalled();

    const onlineRunner = createGroceryPosSyncRunner({
      isOnline: () => true,
      listPending: vi.fn(async () => [pending]),
      postOperation,
      markSynced,
      markFailed,
    });

    await expect(onlineRunner()).resolves.toEqual({ attempted: 1, synced: 1, failed: 0, skipped: false });
    expect(postOperation).toHaveBeenCalledWith(pending);
    expect(markSynced).toHaveBeenCalledWith("op-1", "order-1");
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("sync runner marks replay failure without deleting the queued operation", async () => {
    const pending = operation();
    const runner = createGroceryPosSyncRunner({
      isOnline: () => true,
      listPending: vi.fn(async () => [pending]),
      postOperation: vi.fn(async () => ({ ok: false as const, error: "stale_catalog" })),
      markSynced: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    });

    await expect(runner()).resolves.toEqual({ attempted: 1, synced: 0, failed: 1, skipped: false });
  });

  it("changes catalog version when variant or modifier pricing changes", () => {
    const product = {
      id: "product-1",
      basePrice: 35,
      isActive: true,
      availableForPos: true,
      availableForQr: true,
      updatedAt: "2026-06-21T03:00:00.000Z",
      variants: [
        {
          id: "variant-1",
          name: "Large",
          priceAdjustment: 5,
          trackStock: true,
          isActive: true,
          sortOrder: 1,
        },
      ],
      modifierGroups: [
        {
          id: "group-1",
          name: "Toppings",
          selectionType: "multiple" as const,
          isRequired: false,
          minSelections: 0,
          maxSelections: 3,
          sortOrder: 1,
          options: [
            {
              id: "option-1",
              name: "Cheese",
              priceAdjustment: 10,
              isDefault: false,
              isActive: true,
              sortOrder: 1,
            },
          ],
        },
      ],
    };
    const baseVersion = buildGroceryCatalogVersion({ products: [product] });

    expect(
      buildGroceryCatalogVersion({
        products: [{ ...product, variants: [{ ...product.variants[0], priceAdjustment: 12 }] }],
      }),
    ).not.toBe(baseVersion);
    expect(
      buildGroceryCatalogVersion({
        products: [
          {
            ...product,
            modifierGroups: [
              {
                ...product.modifierGroups[0],
                options: [{ ...product.modifierGroups[0].options[0], priceAdjustment: 15 }],
              },
            ],
          },
        ],
      }),
    ).not.toBe(baseVersion);
    expect(
      buildGroceryCatalogVersion({
        products: [
          {
            ...product,
            modifierGroups: [
              {
                ...product.modifierGroups[0],
                options: [{ ...product.modifierGroups[0].options[0], isActive: false }],
              },
            ],
          },
        ],
      }),
    ).not.toBe(baseVersion);
  });

  it("adds database tables and RLS for offline devices and operations", () => {
    const migration = readFileSync(
      "supabase/migrations/20260621030000_grocery_pos_offline_sync.sql",
      "utf8",
    );

    expect(migration).toContain("create table if not exists pos_devices");
    expect(migration).toContain("create table if not exists pos_sync_operations");
    expect(migration).toContain("unique (store_id, idempotency_key)");
    expect(migration).toContain("alter table pos_devices enable row level security");
    expect(migration).toContain("alter table pos_sync_operations enable row level security");
    expect(migration).toContain("pos_sync_operations: cashier+ can write");
  });

  it("keeps failed replay attempts in the server operation log", () => {
    const migration = readFileSync(
      "supabase/migrations/20260621031000_fix_grocery_pos_offline_sync_failure_logging.sql",
      "utf8",
    );

    expect(migration).toContain("create or replace function replay_grocery_pos_create_order_with_sync");
    expect(migration).toContain("status = 'failed'");
    expect(migration).toContain("error_message = sqlerrm");
    expect(migration).toContain("return null");
    expect(migration).toContain("revoke execute on function replay_grocery_pos_create_order_with_sync");
    expect(migration).toContain("from public");
    expect(migration).toContain('drop policy if exists "pos_sync_operations: cashier+ can write"');
    expect(migration).toContain("revoke insert, update, delete on pos_sync_operations from authenticated");
    expect(migration).not.toContain("raise;");
  });

  it("records stale catalog replay as a conflict instead of silently repricing", () => {
    const migration = readFileSync(
      "supabase/migrations/20260621031000_fix_grocery_pos_offline_sync_failure_logging.sql",
      "utf8",
    );
    const checkoutService = readFileSync("src/modules/grocery-pos/checkout-service.ts", "utf8");
    const route = readFileSync("src/app/api/pos/grocery/sync/route.ts", "utf8");

    expect(migration).toContain("create or replace function record_grocery_pos_sync_conflict");
    expect(migration).toContain("'conflict'");
    expect(migration).toContain("status = case");
    expect(migration).toContain("grant execute on function record_grocery_pos_sync_conflict");
    expect(checkoutService).toContain("buildGroceryCatalogVersion");
    expect(checkoutService).toContain("recordGrocerySyncConflict");
    expect(route).toContain("catalog_conflict");
    expect(route).toContain("? 409 : 422");
  });

  it("preserves succeeded sync operation audit fields when recording later catalog conflicts", () => {
    const migration = readFileSync(
      "supabase/migrations/20260621032000_harden_grocery_pos_sync_conflict.sql",
      "utf8",
    );

    expect(migration).toContain("create or replace function record_grocery_pos_sync_conflict");
    expect(migration).toContain("when pos_sync_operations.status = 'succeeded' then pos_sync_operations.device_id");
    expect(migration).toContain("when pos_sync_operations.status = 'succeeded' then pos_sync_operations.catalog_version");
    expect(migration).toContain("when pos_sync_operations.status = 'succeeded' then pos_sync_operations.payload");
    expect(migration).toContain("when pos_sync_operations.status = 'succeeded' then pos_sync_operations.attempt_count");
    expect(migration).toContain("when pos_sync_operations.status = 'succeeded' then pos_sync_operations.last_attempt_at");
  });

  it("uses the same idempotency log for online create and offline replay when offline POS is enabled", () => {
    const terminal = readFileSync("src/app/pos/grocery/GroceryPosTerminal.tsx", "utf8");
    const actions = readFileSync("src/app/pos/grocery/actions.ts", "utf8");

    expect(terminal).toContain("sync: offlineEnabled");
    expect(terminal).toContain("operationPayload");
    expect(actions).toContain('await requireFeature("offlinePos")');
    expect(actions).toContain("sync: input.sync");
  });

  it("does not enqueue offline orders when the current plan lacks offline POS", () => {
    const page = readFileSync("src/app/pos/grocery/page.tsx", "utf8");
    const terminal = readFileSync("src/app/pos/grocery/GroceryPosTerminal.tsx", "utf8");

    expect(page).toContain("offlineEnabled");
    expect(page).toContain("offlineUnavailableMessage");
    expect(terminal).toContain("if (!offlineEnabled)");
    expect(terminal).toContain("ไม่รองรับ Offline POS");
  });

  it("ignores local dev and browser artifacts", () => {
    const gitignore = readFileSync(".gitignore", "utf8");

    expect(gitignore).toContain(".codex*.log");
    expect(gitignore).toContain(".preview-dev.log");
    expect(gitignore).toContain(".playwright-cli/");
  });

  it("exposes a gated sync endpoint that reuses trusted checkout creation", () => {
    const route = readFileSync("src/app/api/pos/grocery/sync/route.ts", "utf8");

    expect(route).toContain('requireFeature("groceryPos")');
    expect(route).toContain('requireFeature("offlinePos")');
    expect(route).toContain("createTrustedGroceryOrder");
    expect(route).toContain("idempotencyKey");
  });

  it("wires Grocery POS UI to the offline queue and sync status", () => {
    const terminal = readFileSync("src/app/pos/grocery/GroceryPosTerminal.tsx", "utf8");

    expect(terminal).toContain("installGroceryPosOfflineSync");
    expect(terminal).toContain("enqueueGroceryOfflineOrder");
    expect(terminal).toContain("offlineSyncState");
    expect(terminal).toContain("pendingOperations");
  });
});
