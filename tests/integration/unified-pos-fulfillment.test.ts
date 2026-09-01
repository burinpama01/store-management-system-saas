import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UNIFIED_POS_ERROR_CODES } from "@/modules/unified-pos/contracts";
import { computeRequestHash, createOperationKey } from "@/modules/unified-pos/envelope";
import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// Task U5 — versioned item fulfillment + order prep derive (v0.35.5)
// ต้องตั้ง env ก่อนรัน (ขาด = skip ทั้ง describe เพื่อไม่พังตอน npm test ทั่วไป):
//   LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และต้อง `supabase db reset` หลังเพิ่ม migration 20260901000003 ก่อนรัน
//
// Fixture ร้าน seed (seed.sql): org/store/table/product/variant/option + owner@demo.local
// เคสตามแผน U5 (RED):
//   full transition matrix new→preparing→ready→served + derive หลังทุก step /
//   reject reverse/skip/same/stale/voided / customer cancel ok + reject /
//   cross-store denial / concurrent expected-version winner / replay + hash_conflict /
//   flag false → up_store_flag_disabled / ไม่มีสิทธิ์ → up_forbidden

const envReady =
  !!process.env.LOCAL_SUPABASE_URL &&
  !!process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY &&
  !!process.env.LOCAL_SUPABASE_SERVICE_KEY;

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_A = "cccccccc-0000-0000-0000-000000000001";
const STORE_B = "cccccccc-0000-0000-0000-0000000000b1";
const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
const PRODUCT_1 = "22222222-0000-0000-0000-000000000001";
const VARIANT_1 = "33333333-0000-0000-0000-000000000001";
const OPTION_1 = "55555555-0000-0000-0000-000000000001";
const STATION_NAME = "U5 Integration Station";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_EMAIL = "owner@demo.local";
const OWNER_PASSWORD = "demo1234";

type ItemFulfillmentResult = {
  order_id: string;
  item_id: string;
  fulfillment_status: string;
  fulfillment_version: number;
  order_prep_status: string;
  order_revision: number;
};
type CancelResult = {
  order_id: string;
  order_number: string;
  status: string;
  order_prep_status: string;
};
type GovernedOutcome<T> =
  | { status: "executed"; result: T }
  | { status: "replayed"; result: T | null }
  | { status: "hash_conflict" }
  | { status: "error"; code: string; message: string };

interface ItemRow {
  id: string;
  voided: boolean;
  fulfillment_status: string;
  fulfillment_version: number;
}

describe.skipIf(!envReady)("unified-pos-fulfillment integration (U5, local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;
  let owner: SupabaseClient;
  let runId: string;
  let stationId: string | null = null;
  const createdOrderIds: string[] = [];
  const createdReceiptKeys: string[] = [];

  const storeDefaults = { unified_pos_enabled: false, table_open_policy: "staff_only" };
  const tableDefaults = { qr_enabled: false, session_started_at: null, session_expires_at: null, status: "available" };
  const productDefaults = { available_for_qr: false, kitchen_station_id: null };
  const variantDefaults = { track_stock: false, stock_quantity: null };

  beforeAll(async () => {
    local = getLocalSupabase();
    service = local.client;

    owner = createClient(local.url, local.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await owner.auth.signInWithPassword({
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    expect(error, `signInWithPassword ของ ${OWNER_EMAIL} ต้องสำเร็จ: ${error?.message}`).toBeNull();

    runId = Math.random().toString(36).slice(2, 10);

    // --- fixture: เปิด flag/policy/qr + station + stock (แบบเดียวกับ U4) ---
    const { error: storeErr } = await service
      .from("stores")
      .update({ unified_pos_enabled: true, qr_ordering_enabled: true, table_open_policy: "customer_self" })
      .eq("id", STORE_A);
    expect(storeErr, `เปิด store flags ต้องสำเร็จ: ${storeErr?.message}`).toBeNull();

    const { error: tableErr } = await service
      .from("tables")
      .update({ qr_enabled: true, session_started_at: new Date().toISOString(), session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
      .eq("id", TABLE_1);
    expect(tableErr, `เปิด qr ของโต๊ะต้องสำเร็จ: ${tableErr?.message}`).toBeNull();

    const { data: station, error: stationErr } = await service
      .from("kitchen_stations")
      .insert({ organization_id: ORG_A, store_id: STORE_A, name: `${STATION_NAME} ${runId}` })
      .select("id")
      .single();
    expect(stationErr, `สร้าง kitchen station ต้องสำเร็จ: ${stationErr?.message}`).toBeNull();
    stationId = station!.id;

    const { error: productErr } = await service
      .from("products")
      .update({ available_for_qr: true, kitchen_station_id: stationId })
      .eq("id", PRODUCT_1);
    expect(productErr, `เปิด available_for_qr + station ต้องสำเร็จ: ${productErr?.message}`).toBeNull();

    const { error: variantErr } = await service
      .from("product_variants")
      .update({ track_stock: true, stock_quantity: 50 })
      .eq("id", VARIANT_1);
    expect(variantErr, `ตั้งสต๊อก variant ต้องสำเร็จ: ${variantErr?.message}`).toBeNull();
  });

  afterAll(async () => {
    // cleanup best-effort: order → receipt tombstone → station/store B → คืนค่า fixture
    if (service) {
      if (createdOrderIds.length > 0) {
        await service.from("orders").delete().in("id", createdOrderIds);
      }
      for (const key of createdReceiptKeys) {
        await service.from("unified_pos_operation_receipts").delete().eq("operation_key", key).eq("store_id", STORE_A);
      }
      if (stationId) {
        await service.from("kitchen_stations").delete().eq("id", stationId);
      }
      await service.from("stores").delete().eq("id", STORE_B);
      await service.from("product_variants").update(variantDefaults).eq("id", VARIANT_1);
      await service.from("products").update(productDefaults).eq("id", PRODUCT_1);
      await service.from("tables").update(tableDefaults).eq("id", TABLE_1);
      await service.from("stores").update(storeDefaults).eq("id", STORE_A);
    }
    if (owner) {
      await owner.auth.signOut();
    }
  });

  /** item ที่ผ่าน validation ของ seed: 45 (base) + 0 (variant) + 0 (modifier) */
  function makeItems(quantity: number) {
    return [
      {
        product_id: PRODUCT_1,
        product_name: "กาแฟดำ",
        variant_id: VARIANT_1,
        variant_name: "เล็ก (S)",
        modifiers: [{ option: { id: OPTION_1, name: "ไม่หวาน", priceAdjustment: 0 } }],
        quantity,
        unit_price: 45,
        total_price: 45 * quantity,
        note: null,
      },
    ];
  }

  /** submit QR order แบบ N lines (qty 1 ต่อ line) เพื่อให้ได้ item ครบ N แถว */
  async function submitQrOrder(orderNumber: string, quantity: number): Promise<string> {
    const lines = Array.from({ length: quantity }, (_, i) => ({ ...makeItems(1)[0]!, note: `line-${i}` }));
    const requestHash = computeRequestHash({ storeId: STORE_A, tableId: TABLE_1, subtotal: 45 * quantity, items: lines });
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: ORG_A,
      p_store_id: STORE_A,
      p_table_id: TABLE_1,
      p_order_number: orderNumber,
      p_operation_key: createOperationKey(),
      p_request_hash: requestHash,
      p_subtotal: 45 * quantity,
      p_items: lines,
    });
    expect(error, `submit v2 ต้องไม่ throw: ${error?.message}`).toBeNull();
    const outcome = data as GovernedOutcome<{ order_id: string }>;
    expect(outcome.status).toBe("executed");
    const orderId = (outcome as Extract<GovernedOutcome<{ order_id: string }>, { status: "executed" }>).result.order_id;
    createdOrderIds.push(orderId);
    return orderId;
  }

  async function fetchItems(orderId: string): Promise<ItemRow[]> {
    const { data, error } = await service
      .from("order_items")
      .select("id, voided, fulfillment_status, fulfillment_version")
      .eq("order_id", orderId)
      .order("id", { ascending: true });
    expect(error).toBeNull();
    return (data ?? []) as ItemRow[];
  }

  async function fetchOrder(orderId: string): Promise<{ status: string; prep_status: string; revision: number; paid_at: string | null }> {
    const { data, error } = await service
      .from("orders")
      .select("status, prep_status, revision, paid_at")
      .eq("id", orderId)
      .single();
    expect(error).toBeNull();
    return data as { status: string; prep_status: string; revision: number; paid_at: string | null };
  }

  async function callFulfillment(input: {
    storeId?: string;
    orderId: string;
    itemId: string;
    expectedVersion: number;
    target: string;
    actorUserId?: string | null;
    operationKey?: string;
    requestHash?: string;
  }): Promise<GovernedOutcome<ItemFulfillmentResult>> {
    const { data, error } = await service.rpc("unified_pos_update_item_fulfillment", {
      p_organization_id: ORG_A,
      p_store_id: input.storeId ?? STORE_A,
      p_order_id: input.orderId,
      p_item_id: input.itemId,
      p_expected_fulfillment_version: input.expectedVersion,
      p_target_fulfillment_status: input.target,
      p_operation_key: input.operationKey ?? createOperationKey(),
      p_request_hash: input.requestHash ?? computeRequestHash({ storeId: STORE_A, orderId: input.orderId, itemId: input.itemId, target: input.target, expectedVersion: input.expectedVersion }),
      p_actor_user_id: input.actorUserId === undefined ? OWNER_ID : input.actorUserId,
    });
    expect(error, `RPC unified_pos_update_item_fulfillment ต้องไม่ throw: ${error?.message}`).toBeNull();
    return data as GovernedOutcome<ItemFulfillmentResult>;
  }

  async function callCustomerCancel(input: {
    orderId: string;
    tableId?: string;
  }): Promise<GovernedOutcome<CancelResult>> {
    const { data, error } = await service.rpc("unified_pos_cancel_table_order", {
      p_organization_id: ORG_A,
      p_store_id: STORE_A,
      p_table_id: input.tableId ?? TABLE_1,
      p_order_id: input.orderId,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({ storeId: STORE_A, tableId: input.tableId ?? TABLE_1, orderId: input.orderId }),
    });
    expect(error, `RPC unified_pos_cancel_table_order ต้องไม่ throw: ${error?.message}`).toBeNull();
    return data as GovernedOutcome<CancelResult>;
  }

  it("fulfillment transition matrix ครบ new→preparing→ready→served + derive order prep หลังทุก step", { timeout: 120_000 }, async () => {
    const orderId = await submitQrOrder(`U5-${runId}-MATRIX`, 2);
    let items = await fetchItems(orderId);
    expect(items).toHaveLength(2);
    const firstId = items[0]!.id;
    const secondId = items[1]!.id;
    expect(items[0]!.fulfillment_status).toBe("new");
    expect(items[0]!.fulfillment_version).toBe(1);
    expect((await fetchOrder(orderId)).prep_status).toBe("new");

    /** ดึง version ล่าสุดของ item ก่อน move ทุกครั้ง (กันค่า local เก่า) */
    const fresh = async (itemId: string) => {
      const rows = await fetchItems(orderId);
      return rows.find((r) => r.id === itemId)!;
    };
    const move = async (itemId: string, target: string) => {
      const row = await fresh(itemId);
      return callFulfillment({ orderId, itemId, expectedVersion: row.fulfillment_version, target });
    };

    // step 1: item เดียวก่อน → mixed (new+preparing) → derive 'preparing'
    let outcome = await move(firstId, "preparing");
    expect(outcome.status).toBe("executed");
    let result = (outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "executed" }>).result;
    expect(result.fulfillment_status).toBe("preparing");
    expect(result.fulfillment_version).toBe(2);
    expect(result.order_prep_status).toBe("preparing");
    expect((await fetchOrder(orderId)).prep_status).toBe("preparing");

    // step 2: item ที่สองถึง preparing → all preparing → 'preparing'
    outcome = await move(secondId, "preparing");
    expect(outcome.status).toBe("executed");
    expect((await fetchOrder(orderId)).prep_status).toBe("preparing");

    // step 3-4: ทยอยถึง ready — mixed → 'preparing', all ready → 'ready'
    outcome = await move(firstId, "ready");
    expect(outcome.status).toBe("executed");
    result = (outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "executed" }>).result;
    expect(result.order_prep_status).toBe("preparing"); // mixed preparing+ready
    outcome = await move(secondId, "ready");
    expect(outcome.status).toBe("executed");
    expect((await fetchOrder(orderId)).prep_status).toBe("ready");

    // step 5-6: ทยอย served — mixed ready+served → 'ready', all served → 'served'
    outcome = await move(firstId, "served");
    expect(outcome.status).toBe("executed");
    expect((outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "executed" }>).result.order_prep_status).toBe("ready");
    outcome = await move(secondId, "served");
    expect(outcome.status).toBe("executed");
    result = (outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "executed" }>).result;
    expect(result.order_prep_status).toBe("served");
    expect((await fetchOrder(orderId)).prep_status).toBe("served");
    items = await fetchItems(orderId);
    expect(items.every((r) => r.fulfillment_status === "served")).toBe(true);
  });

  it("fulfillment rejects: reverse / skip / same-status transition ด้วย up_invalid_state_transition", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U5-${runId}-REJECT`, 1);
    const [item] = await fetchItems(orderId);

    // skip: new → ready
    let outcome = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "ready" });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.invalid_state_transition,
    );

    // forward ไป preparing แล้วลองย้อนกลับ + สั่งซ้ำ
    const ok = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing" });
    expect(ok.status).toBe("executed");
    item!.fulfillment_version += 1;

    outcome = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "new" });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.invalid_state_transition,
    );

    outcome = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing" });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.invalid_state_transition,
    );

    // target นอก enum ก็ต้องถูกปฏิเสธ
    outcome = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "voided" });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.invalid_state_transition,
    );
    expect((await fetchOrder(orderId)).prep_status).toBe("preparing");
  });

  it("fulfillment stale expected version → up_stale_version โดยไม่ mutate", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U5-${runId}-STALE`, 1);
    const [item] = await fetchItems(orderId);

    const outcome = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version - 1, target: "preparing" });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.stale_version,
    );
    expect((await fetchItems(orderId))[0]!.fulfillment_status).toBe("new");
  });

  it("fulfillment voided item → up_invalid_item (void ด้วย fixture update เพื่อทดสอบ guard)", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U5-${runId}-VOID`, 1);
    const [item] = await fetchItems(orderId);
    // fixture update ตรง (service context ไม่มี JWT สำหรับ void_qr_order_item เดิม)
    // — trigger จะ bump version + derive ให้เอง
    const { error: voidErr } = await service
      .from("order_items")
      .update({ voided: true, voided_reason: "ของหมด" })
      .eq("id", item!.id);
    expect(voidErr).toBeNull();

    const outcome = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing" });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.invalid_item,
    );

    // ทุก active item หมด → derive 'done'
    expect((await fetchOrder(orderId)).prep_status).toBe("done");
  });

  it("fulfillment cross-store denial: order ของ store A เรียกผ่าน store B → up_not_found โดยไม่ mutate", { timeout: 60_000 }, async () => {
    const { error: storeErr } = await service
      .from("stores")
      .insert({
        id: STORE_B,
        organization_id: ORG_A,
        name: "U5 Store B",
        slug: `u5-store-b-${runId}`,
        is_active: true,
        unified_pos_enabled: true,
      });
    expect(storeErr, `สร้าง store B ต้องสำเร็จ: ${storeErr?.message}`).toBeNull();

    const orderId = await submitQrOrder(`U5-${runId}-XSTORE`, 1);
    const [item] = await fetchItems(orderId);

    const outcome = await callFulfillment({ storeId: STORE_B, orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing" });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.not_found,
    );
    expect((await fetchItems(orderId))[0]!.fulfillment_status).toBe("new");
  });

  it("fulfillment concurrent update expected-version เดียวกัน → executed 1 + up_stale_version 1", { timeout: 120_000 }, async () => {
    const orderId = await submitQrOrder(`U5-${runId}-RACE`, 1);
    const [item] = await fetchItems(orderId);

    const results = await Promise.all([
      callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing" }),
      callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing" }),
      callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing" }),
    ]);

    const executed = results.filter((r) => r.status === "executed");
    const stale = results.filter((r) => r.status === "error" && (r as { code: string }).code === UNIFIED_POS_ERROR_CODES.stale_version);
    expect(executed).toHaveLength(1);
    expect(stale).toHaveLength(results.length - 1);
    expect((await fetchItems(orderId))[0]!.fulfillment_status).toBe("preparing");
    expect((await fetchItems(orderId))[0]!.fulfillment_version).toBe(2);
  });

  it("fulfillment idempotency: same key+hash → replayed / same key ต่าง hash → hash_conflict", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U5-${runId}-IDEM`, 1);
    const [item] = await fetchItems(orderId);
    const operationKey = createOperationKey();
    const requestHash = computeRequestHash({ storeId: STORE_A, orderId, itemId: item!.id, target: "preparing", expectedVersion: item!.fulfillment_version });
    createdReceiptKeys.push(operationKey);

    const first = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing", operationKey, requestHash });
    expect(first.status).toBe("executed");
    const firstResult = (first as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "executed" }>).result;

    const replay = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing", operationKey, requestHash });
    expect(replay.status).toBe("replayed");
    expect((replay as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "replayed" }>).result?.item_id).toBe(firstResult.item_id);

    const conflict = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "ready", operationKey, requestHash: computeRequestHash({ storeId: STORE_A, orderId, itemId: item!.id, target: "ready", expectedVersion: item!.fulfillment_version }) });
    expect(conflict.status).toBe("hash_conflict");

    // item ต้องถูก move ครั้งเดียว
    expect((await fetchItems(orderId))[0]!.fulfillment_status).toBe("preparing");
    expect((await fetchItems(orderId))[0]!.fulfillment_version).toBe(2);
  });

  it("fulfillment guards: flag false → up_store_flag_disabled / actor ไม่มี membership → up_forbidden", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U5-${runId}-GUARD`, 1);
    const [item] = await fetchItems(orderId);

    const { error: flagErr } = await service.from("stores").update({ unified_pos_enabled: false }).eq("id", STORE_A);
    expect(flagErr).toBeNull();
    try {
      const disabled = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing" });
      expect(disabled.status).toBe("error");
      expect((disabled as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
        UNIFIED_POS_ERROR_CODES.store_flag_disabled,
      );
    } finally {
      await service.from("stores").update({ unified_pos_enabled: true }).eq("id", STORE_A);
    }

    const forbidden = await callFulfillment({ orderId, itemId: item!.id, expectedVersion: item!.fulfillment_version, target: "preparing", actorUserId: "00000000-0000-0000-0000-000000000099" });
    expect(forbidden.status).toBe("error");
    expect((forbidden as Extract<GovernedOutcome<ItemFulfillmentResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.forbidden,
    );
    expect((await fetchItems(orderId))[0]!.fulfillment_status).toBe("new");
  });

  it("customer cancel: ทุก active item ยัง new + unpaid/open → cancelled + prep done + คืนสต๊อก", { timeout: 120_000 }, async () => {
    const { data: stockBefore } = await service.from("product_variants").select("stock_quantity").eq("id", VARIANT_1).single();
    const orderId = await submitQrOrder(`U5-${runId}-CANCEL`, 2);
    const { data: stockAfterSubmit } = await service.from("product_variants").select("stock_quantity").eq("id", VARIANT_1).single();
    expect(stockAfterSubmit!.stock_quantity).toBe(stockBefore!.stock_quantity - 2);

    const outcome = await callCustomerCancel({ orderId });
    expect(outcome.status).toBe("executed");
    const result = (outcome as Extract<GovernedOutcome<CancelResult>, { status: "executed" }>).result;
    expect(result.order_prep_status).toBe("done");
    expect(result.status).toBe("cancelled");

    const order = await fetchOrder(orderId);
    expect(order.status).toBe("cancelled");
    expect(order.prep_status).toBe("done");

    const { data: stockAfterCancel } = await service.from("product_variants").select("stock_quantity").eq("id", VARIANT_1).single();
    expect(stockAfterCancel!.stock_quantity).toBe(stockBefore!.stock_quantity);

    // ยกเลิกซ้ำ (order ปิดแล้ว) → cancel_not_allowed
    const again = await callCustomerCancel({ orderId });
    expect(again.status).toBe("error");
    expect((again as Extract<GovernedOutcome<CancelResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.cancel_not_allowed,
    );
  });

  it("customer cancel reject: item ถูกเตรียมแล้ว / ชำระแล้ว / ไม่ใช่ QR order", { timeout: 120_000 }, async () => {
    // 1) item ถูกเลื่อนไป preparing แล้ว
    const moving = await submitQrOrder(`U5-${runId}-C-REJ1`, 1);
    const [movingItem] = await fetchItems(moving);
    const moved = await callFulfillment({ orderId: moving, itemId: movingItem!.id, expectedVersion: movingItem!.fulfillment_version, target: "preparing" });
    expect(moved.status).toBe("executed");
    const rejected1 = await callCustomerCancel({ orderId: moving });
    expect(rejected1.status).toBe("error");
    expect((rejected1 as Extract<GovernedOutcome<CancelResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.cancel_not_allowed,
    );
    expect((await fetchOrder(moving)).status).toBe("open");

    // 2) ชำระแล้ว (fixture: set paid)
    const paid = await submitQrOrder(`U5-${runId}-C-REJ2`, 1);
    const { error: paidErr } = await service
      .from("orders")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("id", paid);
    expect(paidErr).toBeNull();
    const rejected2 = await callCustomerCancel({ orderId: paid });
    expect(rejected2.status).toBe("error");
    expect((rejected2 as Extract<GovernedOutcome<CancelResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.cancel_not_allowed,
    );

    // 3) ไม่ใช่ QR order (staff สร้าง — qr_order_source=false, fixture insert ตรง)
    const { data: staffOrder, error: staffOrderErr } = await service
      .from("orders")
      .insert({
        organization_id: ORG_A,
        store_id: STORE_A,
        order_number: `U5-${runId}-C-REJ3`,
        status: "open",
        table_id: TABLE_1,
        subtotal: 45,
        discount: 0,
        total: 45,
        qr_order_source: false,
      })
      .select("id")
      .single();
    expect(staffOrderErr).toBeNull();
    createdOrderIds.push(staffOrder!.id);
    const { error: itemErr } = await service.from("order_items").insert({
      order_id: staffOrder!.id,
      product_id: PRODUCT_1,
      product_name: "กาแฟดำ",
      quantity: 1,
      unit_price: 45,
      total_price: 45,
    });
    expect(itemErr).toBeNull();

    const rejected3 = await callCustomerCancel({ orderId: staffOrder!.id });
    expect(rejected3.status).toBe("error");
    expect((rejected3 as Extract<GovernedOutcome<CancelResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.cancel_not_allowed,
    );
    expect((await fetchOrder(staffOrder!.id)).status).toBe("open");
  });
});
