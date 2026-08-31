/**
 * Task U4 (v0.35.4) — QR submit / staff add-items wiring (runtime behavior tests)
 *
 * แผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U4)
 *   - QR action สร้าง operationKey + requestHash และ reuse key เดิมเมื่อ retry
 *   - flag unified_pos_enabled = true → RPC v2 (atomic + idempotent) + map outcome
 *     executed | replayed | hash_conflict | error ตาม contracts (U1)
 *   - staff path → add_items_to_table_v2 + p_actor_user_id (pos.use enforce ที่ action + RPC)
 *   - flag false → เส้นทางเดิม (RPC v1) ไม่เปลี่ยนพฤติกรรม
 *
 * แทนที่ source-string assert เดิมด้วย behavior test: mock Supabase client แล้วดู
 * ว่า action เรียก RPC ใด ด้วย envelope อะไร และ map outcome อย่างไร
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRequestHash,
} from "@/modules/unified-pos/envelope";

const ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE = "cccccccc-0000-0000-0000-000000000001";
const TABLE = "eeeeeeee-0000-0000-0000-000000000001";
const PRODUCT = "22222222-0000-0000-0000-000000000001";
const VARIANT = "33333333-0000-0000-0000-000000000001";
const STATION = "77777777-0000-0000-0000-000000000001";
const ACTOR = "00000000-0000-0000-0000-000000000001";

const { rpcMock, notifyOwnerSafelyMock, notifyLowStockMock, getCurrentUserMock, fixtureDb } = vi.hoisted(() => {
  const nowIso = new Date().toISOString();
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    rpcMock: vi.fn(),
    notifyOwnerSafelyMock: vi.fn(),
    notifyLowStockMock: vi.fn(),
    getCurrentUserMock: vi.fn(),
    fixtureDb: {
      nowIso,
      futureIso,
      defaultTables: [
        {
          id: "eeeeeeee-0000-0000-0000-000000000001",
          store_id: "cccccccc-0000-0000-0000-000000000001",
          number: "1",
          qr_enabled: true,
          is_active: true,
          session_started_at: nowIso as string | null,
          session_expires_at: futureIso as string | null,
          current_session_id: null,
        },
      ],
    },
  };
});

vi.mock("@/server/integrations/supabase/server", () => ({
  createSupabaseServiceClient: async () => {
    const builder = (rows: unknown[]) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = chain;
      b.eq = chain;
      b.in = chain;
      b.order = chain;
      b.gte = chain;
      b.single = () => Promise.resolve({ data: rows[0] ?? null, error: null });
      b.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
      b.then = (
        resolve: (value: { data: unknown[]; error: null }) => unknown,
        reject: (reason?: unknown) => unknown,
      ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      return b;
    };
    const db: Record<string, unknown[]> = {
      stores: [
        {
          id: STORE,
          organization_id: ORG,
          qr_ordering_enabled: true,
          is_active: true,
          timezone: "Asia/Bangkok",
          qr_ordering_mode: "table_bound",
          table_open_policy: "customer_self",
          unified_pos_enabled: storeFlagValue,
        },
      ],
      tables: fixtureDb.defaultTables,
      products: [
        {
          id: PRODUCT,
          store_id: STORE,
          name: "กาแฟดำ",
          base_price: 45,
          is_active: true,
          available_for_qr: true,
          out_of_stock: false,
          kitchen_station_id: STATION,
        },
      ],
      kitchen_stations: [{ id: STATION }],
      product_variants: [
        {
          id: VARIANT,
          product_id: PRODUCT,
          name: "เล็ก (S)",
          price_adjustment: 0,
          stock_quantity: 5,
          track_stock: false,
          is_active: true,
        },
      ],
      modifier_groups: [],
      modifier_options: [],
    };
    return {
      from: (table: string) => builder(db[table] ?? []),
      rpc: rpcMock,
    };
  },
}));

vi.mock("@/modules/billing/billing-service", () => ({
  getOrganizationBillingState: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/modules/billing/types", () => ({
  DEFAULT_BILLING_STATE: {},
  getPlanFeatures: vi.fn().mockReturnValue({ qrOrdering: true }),
}));
vi.mock("@/modules/notifications/dispatcher", () => ({
  notifyOwnerSafely: notifyOwnerSafelyMock,
}));
vi.mock("@/modules/stock/notify", () => ({
  notifyLowStockAfterSaleSafely: notifyLowStockMock,
}));
vi.mock("@/modules/auth/session", () => ({
  getCurrentUser: getCurrentUserMock,
}));

import { submitQrOrderAction, type QrOrderItem } from "@/app/qr/[storeSlug]/[tableId]/actions";

let storeFlagValue = true;

const items: QrOrderItem[] = [
  { productId: PRODUCT, variantId: VARIANT, modifierOptionIds: [], quantity: 1 },
];

const executedResult = {
  order_id: "order-1",
  order_number: "QR-1",
  table_id: TABLE,
  table_number: "1",
  subtotal: 45,
  revision: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  storeFlagValue = true;
  getCurrentUserMock.mockResolvedValue({ id: ACTOR });
  rpcMock.mockResolvedValue({
    data: { status: "executed", result: executedResult },
    error: null,
  });
});

function lastRpcCall(): { name: string; args: Record<string, unknown> } {
  expect(rpcMock).toHaveBeenCalled();
  const [name, args] = rpcMock.mock.calls.at(-1)!;
  return { name, args };
}

describe("submitQrOrderAction — flag on → RPC v2 + outcome mapping (U4)", () => {
  it("executed → เรียก create_qr_order_with_items_v2 พร้อม envelope และคืน orderId/orderNumber + แจ้งเตือน", async () => {
    const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");

    expect(res).toEqual({ orderId: "order-1", orderNumber: "QR-1", error: null });
    const { name, args } = lastRpcCall();
    expect(name).toBe("create_qr_order_with_items_v2");
    expect(args.p_store_id).toBe(STORE);
    expect(args.p_table_id).toBe(TABLE);
    expect(args.p_operation_key).toBe("0123456789abcdef");
    // hash ตรงกับที่คำนวณจาก payload semantic เดียวกัน (storeId/tableId/subtotal/items)
    expect(args.p_request_hash).toBe(
      computeRequestHash({ storeId: STORE, tableId: TABLE, subtotal: 45, items }),
    );
    expect(args.p_items).toHaveLength(1);
    expect(notifyOwnerSafelyMock).toHaveBeenCalledTimes(1);
    expect(notifyLowStockMock).toHaveBeenCalledTimes(1);
  });

  it("replayed → คืน result เดิมและไม่แจ้งเตือนซ้ำ", async () => {
    rpcMock.mockResolvedValue({
      data: { status: "replayed", result: executedResult },
      error: null,
    });

    const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");

    expect(res).toEqual({ orderId: "order-1", orderNumber: "QR-1", error: null });
    expect(notifyOwnerSafelyMock).not.toHaveBeenCalled();
    expect(notifyLowStockMock).not.toHaveBeenCalled();
  });

  it("replayed ที่ result ถูก purge (null) → error ให้สั่งใหม่ (tombstone ยังกัน execute ซ้ำ)", async () => {
    rpcMock.mockResolvedValue({ data: { status: "replayed", result: null }, error: null });

    const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");

    expect(res.orderId).toBeNull();
    expect(res.error).toContain("สั่งใหม่");
    expect(notifyOwnerSafelyMock).not.toHaveBeenCalled();
  });

  it("hash_conflict → error ที่เหมาะสมและไม่แจ้งเตือน", async () => {
    rpcMock.mockResolvedValue({ data: { status: "hash_conflict" }, error: null });

    const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");

    expect(res.orderId).toBeNull();
    expect(res.error).toContain("ต่างกัน");
    expect(notifyOwnerSafelyMock).not.toHaveBeenCalled();
  });

  it("error outcome → ส่ง message + code จาก RPC ตรงไปยังผู้เรียก", async () => {
    rpcMock.mockResolvedValue({
      data: { status: "error", code: "up_stock_insufficient", message: "สินค้าเหลือไม่พอ" },
      error: null,
    });

    const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");

    expect(res).toEqual({ orderId: null, orderNumber: null, error: "สินค้าเหลือไม่พอ" });
  });

  it("ไม่ส่ง operationKey → server สร้าง key ให้ต่อ request (uuid)", async () => {
    await submitQrOrderAction(STORE, TABLE, items);
    const { args } = lastRpcCall();
    expect(typeof args.p_operation_key).toBe("string");
    expect((args.p_operation_key as string).length).toBe(36);
  });

  it("retry ของคำขอเดียวกัน (key เดิม payload เดิม) → hash เดิม; payload ต่าง → hash ต่าง", async () => {
    await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");
    const hash1 = lastRpcCall().args.p_request_hash;

    await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");
    const hash2 = lastRpcCall().args.p_request_hash;
    expect(hash2).toBe(hash1); // retry ต้อง replay ไม่ใช่ conflict

    await submitQrOrderAction(
      STORE,
      TABLE,
      [{ ...items[0], quantity: 2 }],
      "0123456789abcdef",
    );
    const hash3 = lastRpcCall().args.p_request_hash;
    expect(hash3).not.toBe(hash1); // payload ต่างจริง → ต้อง conflict ได้
  });

  it("session หมดอายุ + customer_self + flag on → ไม่เรียก open_table_session_self (RPC v2 auto-open เอง)", async () => {
    fixtureDb.defaultTables[0].session_started_at = null;
    fixtureDb.defaultTables[0].session_expires_at = null;

    try {
      const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");
      expect(res.error).toBeNull();
      expect(rpcMock.mock.calls.map((c) => c[0])).not.toContain("open_table_session_self");
      expect(lastRpcCall().name).toBe("create_qr_order_with_items_v2");
    } finally {
      fixtureDb.defaultTables[0].session_started_at = fixtureDb.nowIso;
      fixtureDb.defaultTables[0].session_expires_at = fixtureDb.futureIso;
    }
  });
});

describe("submitQrOrderAction — staff path (U4 add-items)", () => {
  it("internalStaffContext ตรง session → add_items_to_table_v2 + p_actor_user_id", async () => {
    const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef", {
      actorUserId: ACTOR,
    });

    expect(res).toEqual({ orderId: "order-1", orderNumber: "QR-1", error: null });
    const { name, args } = lastRpcCall();
    expect(name).toBe("add_items_to_table_v2");
    expect(args.p_actor_user_id).toBe(ACTOR);
  });

  it("actor ไม่ตรง session user → ปฏิเสธ (Invalid request) และไม่เรียก RPC", async () => {
    getCurrentUserMock.mockResolvedValue({ id: "someone-else" });

    const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef", {
      actorUserId: ACTOR,
    });

    expect(res).toEqual({ orderId: null, orderNumber: null, error: "Invalid request" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("staff executed → แจ้งเตือนเจ้าของแต่ไม่เรียก low-stock (ไม่มีการหักสต๊อกตอนสร้าง)", async () => {
    await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef", {
      actorUserId: ACTOR,
    });

    expect(notifyOwnerSafelyMock).toHaveBeenCalledTimes(1);
    expect(notifyLowStockMock).not.toHaveBeenCalled();
  });
});

describe("submitQrOrderAction — flag off → เส้นทางเดิม (v1) ไม่เปลี่ยนพฤติกรรม", () => {
  it("เรียก create_qr_order_with_items (v1) โดยไม่มี p_operation_key", async () => {
    storeFlagValue = false;
    // v1 คืน order id เป็น uuid ตรง ๆ (ไม่ใช่ outcome envelope)
    rpcMock.mockResolvedValue({ data: "order-legacy-1", error: null });

    const res = await submitQrOrderAction(STORE, TABLE, items, "0123456789abcdef");

    expect(res).toEqual({ orderId: "order-legacy-1", orderNumber: expect.any(String), error: null });
    const { name, args } = lastRpcCall();
    expect(name).toBe("create_qr_order_with_items");
    expect(args.p_operation_key).toBeUndefined();
    expect(args.p_request_hash).toBeUndefined();
    expect(notifyOwnerSafelyMock).toHaveBeenCalledTimes(1);
    expect(notifyLowStockMock).toHaveBeenCalledTimes(1);
  });
});
