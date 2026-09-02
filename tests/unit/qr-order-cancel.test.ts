/**
 * Task U12 (v0.37.3) — QR order cancel: governed/legacy routing + stale-cancel
 * คืนสถานะปัจจุบัน (runtime behavior tests)
 *
 * แผน: Plan/QR Order Voice Unified POS Implementation Plan v2.html (Task U12)
 *   - "cancel only before kitchen acceptance; stale request receives current state"
 *   - "flag false old RPC, true v2 RPC; both covered until final cutover"
 *
 * แทน source-string assert ด้วย behavior test: mock Supabase client แล้วดูว่า
 * cancelQrOrderAction เรียก RPC ใด และเมื่อ cancel แพ้ race (ครัวรับ/ปิดออเดอร์ก่อน)
 * ต้องตอบ ok:false + สถานะปัจจุบัน (currentOrder) + ข้อความไทยที่ระบุสถานะ —
 * ไม่ใช่ error ทั่วไป (mapping เองถูกครอบใน qr-order-fulfillment.test.ts)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeRequestHash, isValidOperationKey } from "@/modules/unified-pos/envelope";

const ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE = "cccccccc-0000-0000-0000-000000000001";
const TABLE = "eeeeeeee-0000-0000-0000-000000000001";
const ORDER = "11111111-0000-0000-0000-000000000001";
const ITEM = "11111111-0000-0000-0000-000000000002";

const { rpcMock, fixtureDb } = vi.hoisted(() => {
  const nowIso = new Date().toISOString();
  return {
    rpcMock: vi.fn(),
    fixtureDb: {
      nowIso,
      stores: [] as Array<Record<string, unknown>>,
      orders: [] as Array<Record<string, unknown>>,
      order_items: [] as Array<Record<string, unknown>>,
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
    return {
      from: (table: string) => {
        const rows =
          table === "stores"
            ? fixtureDb.stores
            : table === "orders"
              ? fixtureDb.orders
              : table === "order_items"
                ? fixtureDb.order_items
                : [];
        return builder(rows);
      },
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

import { cancelQrOrderAction } from "@/app/qr/[storeSlug]/[tableId]/actions";

let storeFlagValue = true;

function seedOrder(opts?: {
  prepStatus?: string;
  itemFulfillmentStatus?: string | null;
  itemVoided?: boolean;
  itemVoidedReason?: string | null;
}): void {
  fixtureDb.stores = [
    {
      id: STORE,
      organization_id: ORG,
      is_active: true,
      qr_ordering_enabled: true,
      unified_pos_enabled: storeFlagValue,
    },
  ];
  fixtureDb.orders = [
    {
      id: ORDER,
      order_number: "QR-1",
      status: "open",
      prep_status: opts?.prepStatus ?? "new",
      table_id: TABLE,
      table_number: "1",
      total: 45,
      note: null,
      created_at: fixtureDb.nowIso,
      paid_at: null,
    },
  ];
  fixtureDb.order_items = [
    {
      id: ITEM,
      order_id: ORDER,
      product_name: "กาแฟดำ",
      variant_name: null,
      kitchen_station_id: null,
      kitchen_station_name: null,
      modifiers: [],
      quantity: 1,
      unit_price: 45,
      total_price: 45,
      note: null,
      voided: opts?.itemVoided ?? false,
      voided_reason: opts?.itemVoidedReason ?? null,
      fulfillment_status: opts?.itemFulfillmentStatus ?? "new",
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  storeFlagValue = true;
  rpcMock.mockResolvedValue({ data: null, error: null });
  seedOrder();
});

function lastRpcCall(): { name: string; args: Record<string, unknown> } {
  expect(rpcMock).toHaveBeenCalled();
  const [name, args] = rpcMock.mock.calls.at(-1)!;
  return { name, args };
}

describe("cancelQrOrderAction — flag on → governed RPC (U5) + stale returns current state (U12)", () => {
  it("executed → เรียก unified_pos_cancel_table_order พร้อม envelope (key/hash) และ ok โดยไม่แนบ currentOrder", async () => {
    rpcMock.mockResolvedValue({
      data: {
        status: "executed",
        result: { order_id: ORDER, order_number: "QR-1", status: "cancelled", order_prep_status: "done" },
      },
      error: null,
    });

    const res = await cancelQrOrderAction(STORE, TABLE, ORDER);

    expect(res).toEqual({ ok: true, error: null });
    const { name, args } = lastRpcCall();
    expect(name).toBe("unified_pos_cancel_table_order");
    expect(args.p_store_id).toBe(STORE);
    expect(args.p_table_id).toBe(TABLE);
    expect(args.p_order_id).toBe(ORDER);
    expect(isValidOperationKey(String(args.p_operation_key))).toBe(true);
    expect(args.p_request_hash).toBe(computeRequestHash({ storeId: STORE, tableId: TABLE, orderId: ORDER }));
    expect("currentOrder" in res).toBe(false);
  });

  it("up_cancel_not_allowed (แพ้ race — ครัวรับก่อน) → ok:false + currentOrder สถานะปัจจุบัน + ข้อความไทยที่ระบุสถานะ", async () => {
    rpcMock.mockResolvedValue({
      data: { status: "error", code: "up_cancel_not_allowed", message: "ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้" },
      error: null,
    });
    // snapshot ของลูกค้าคิดว่ายังยกเลิกได้ แต่ server ของจริง: item ถูกรับเป็น preparing แล้ว
    seedOrder({ prepStatus: "preparing", itemFulfillmentStatus: "preparing" });

    const res = await cancelQrOrderAction(STORE, TABLE, ORDER);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้ (สถานะปัจจุบัน: กำลังเตรียม)");
    expect(res.currentOrder).toBeDefined();
    expect(res.currentOrder!.stage).toBe("preparing");
    expect(res.currentOrder!.canCancel).toBe(false);
    expect(res.currentOrder!.orderNumber).toBe("QR-1");
    // U12 contract: ลูกค้าไม่เห็น version/operation key/actor id ในสถานะที่คืน
    expect(JSON.stringify(res.currentOrder)).not.toMatch(/fulfillment_version|operation|actor/i);
  });

  it("error code อื่น (up_not_found) → ตอบ message ตรง โดยไม่แนบ currentOrder", async () => {
    rpcMock.mockResolvedValue({
      data: { status: "error", code: "up_not_found", message: "ไม่พบออเดอร์" },
      error: null,
    });

    const res = await cancelQrOrderAction(STORE, TABLE, ORDER);

    expect(res).toEqual({ ok: false, error: "ไม่พบออเดอร์" });
    expect("currentOrder" in res).toBe(false);
  });

  it("hash_conflict → ข้อความกัน replay โดยไม่แนบ currentOrder", async () => {
    rpcMock.mockResolvedValue({ data: { status: "hash_conflict" }, error: null });

    const res = await cancelQrOrderAction(STORE, TABLE, ORDER);

    expect(res.ok).toBe(false);
    expect(res.error).toContain("ไม่ตรงกับที่ส่งไปก่อนหน้า");
    expect("currentOrder" in res).toBe(false);
  });
});

describe("cancelQrOrderAction — flag off → legacy RPC + stale returns current state (U12)", () => {
  beforeEach(() => {
    storeFlagValue = false;
    seedOrder();
  });

  it("สำเร็จ → เรียก cancel_qr_order_by_customer (3 args เดิม) และ ok", async () => {
    const res = await cancelQrOrderAction(STORE, TABLE, ORDER);

    expect(res).toEqual({ ok: true, error: null });
    const { name, args } = lastRpcCall();
    expect(name).toBe("cancel_qr_order_by_customer");
    expect(args).toEqual({ p_store_id: STORE, p_table_id: TABLE, p_order_id: ORDER });
  });

  it("legacy ปฏิเสธ (ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้) → stale response: สถานะปัจจุบันจาก prep_status รูปแบบเดิม", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้" } });
    // legacy shape: item ยัง default 'new' (ไม่มีการเดินหน้าระดับ item) แต่ prep_status เดินหน้าแล้ว
    seedOrder({ prepStatus: "preparing", itemFulfillmentStatus: "new" });

    const res = await cancelQrOrderAction(STORE, TABLE, ORDER);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้ (สถานะปัจจุบัน: กำลังเตรียม)");
    expect(res.currentOrder).toBeDefined();
    expect(res.currentOrder!.stage).toBe("preparing");
    expect(res.currentOrder!.canCancel).toBe(false);
  });

  it("legacy error ทั่วไป (ไม่พบออเดอร์) → ตอบ message ตรง ไม่แนบ currentOrder", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "ไม่พบออเดอร์" } });

    const res = await cancelQrOrderAction(STORE, TABLE, ORDER);

    expect(res).toEqual({ ok: false, error: "ไม่พบออเดอร์" });
    expect("currentOrder" in res).toBe(false);
  });
});

describe("cancelQrOrderAction — input guard", () => {
  it("uuid ไม่ถูกต้อง → คำขอไม่ถูกต้อง โดยไม่เรียก RPC", async () => {
    const res = await cancelQrOrderAction(STORE, TABLE, "not-a-uuid");

    expect(res).toEqual({ ok: false, error: "คำขอไม่ถูกต้อง" });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
