import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UNIFIED_POS_ERROR_CODES } from "@/modules/unified-pos/contracts";
import { computeRequestHash, createOperationKey } from "@/modules/unified-pos/envelope";
import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// Task U6 — governed item reject/void + stock restore + totals recalc (v0.35.6)
// ต้องตั้ง env ก่อนรัน (ขาด = skip ทั้ง describe เพื่อไม่พังตอน npm test ทั่วไป):
//   LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และต้องมี migration 20260901000004 ใน local DB ก่อนรัน (supabase migration up --local
// หรือ supabase db reset — ห้าม reset เองใน session ที่ orchestrate บางส่วน)
//
// Fixture ร้าน seed (seed.sql): org/store/table/product/variant/option + owner@demo.local
// เคสตามแผน U6 (RED):
//   reject จากทุก state (new/preparing/ready/served) + recalc ทุก step /
//   already-voided + concurrent double-reject คืนสต๊อกครั้งเดียว /
//   paid/closed → up_invalid_state_transition / tracked vs untracked /
//   totals + discount recalc + auto-cancel / same-key replay + hash_conflict /
//   cross-store denial / ไม่มีสิทธิ์ (ไม่มี membership + staff role) /
//   flag off → up_store_flag_disabled / wrapper void_qr_order_item (flag on → canonical,
//   flag off → legacy)

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
const PRODUCT_2 = "22222222-0000-0000-0000-000000000002";
const VARIANT_2 = "33333333-0000-0000-0000-000000000003";
const OPTION_1 = "55555555-0000-0000-0000-000000000001";
const OPTION_2 = "55555555-0000-0000-0000-000000000005";
const STATION_NAME = "U6 Integration Station";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_EMAIL = "owner@demo.local";
const OWNER_PASSWORD = "demo1234";

type RejectResult = {
  order_id: string;
  item_id: string;
  voided: boolean;
  order_status: string;
  order_prep_status: string;
  order_revision: number;
  subtotal: number;
  discount: number;
  total: number;
  stock_restored_quantity: number;
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

describe.skipIf(!envReady)("unified-pos-reject integration (U6, local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;
  let owner: SupabaseClient;
  let runId: string;
  let stationId: string | null = null;
  let staffUserId: string | null = null;
  const createdOrderIds: string[] = [];
  const createdReceiptKeys: string[] = [];

  const storeDefaults = { unified_pos_enabled: false, table_open_policy: "staff_only" };
  const tableDefaults = { qr_enabled: false, session_started_at: null, session_expires_at: null, status: "available" };
  const productDefaults = { available_for_qr: false, kitchen_station_id: null };
  const variantDefaults = { track_stock: false, stock_quantity: null };
  const variant2Defaults = { track_stock: false, stock_quantity: null };

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

    // --- fixture: เปิด flag/policy/qr + station + stock (แบบเดียวกับ U4/U5) ---
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

    const { data: product2, error: product2Err } = await service
      .from("products")
      .update({ available_for_qr: true, kitchen_station_id: stationId })
      .eq("id", PRODUCT_2)
      .select("id")
      .single();
    expect(product2Err, `เปิด available_for_qr ของ product 2 ต้องสำเร็จ: ${product2Err?.message}`).toBeNull();

    const { error: variantErr } = await service
      .from("product_variants")
      .update({ track_stock: true, stock_quantity: 50 })
      .eq("id", VARIANT_1);
    expect(variantErr, `ตั้งสต๊อก variant 1 ต้องสำเร็จ: ${variantErr?.message}`).toBeNull();

    // user สำหรับทดสอบ "สิทธิ์ไม่พอ" (staff มี pos.use แต่ไม่มี orders.manage_qr)
    const { data: created, error: userErr } = await service.auth.admin.createUser({
      email: `u6-staff-${runId}@demo.local`,
      password: "demo1234",
      email_confirm: true,
    });
    expect(userErr, `สร้าง staff user ต้องสำเร็จ: ${userErr?.message}`).toBeNull();
    staffUserId = created!.user!.id;
    const { error: memberErr } = await service.from("memberships").insert({
      organization_id: ORG_A,
      store_id: null,
      user_id: staffUserId,
      role: "staff",
      joined_at: new Date().toISOString(),
    });
    expect(memberErr, `สร้าง membership staff ต้องสำเร็จ: ${memberErr?.message}`).toBeNull();
  });

  afterAll(async () => {
    // cleanup best-effort: order → receipt tombstone → station/users/store B → คืนค่า fixture
    if (service) {
      if (createdOrderIds.length > 0) {
        await service.from("orders").delete().in("id", createdOrderIds);
      }
      for (const key of createdReceiptKeys) {
        await service.from("unified_pos_operation_receipts").delete().eq("operation_key", key).eq("store_id", STORE_A);
        await service.from("unified_pos_operation_receipts").delete().eq("operation_key", key).eq("store_id", STORE_B);
      }
      if (stationId) {
        await service.from("kitchen_stations").delete().eq("id", stationId);
      }
      if (staffUserId) {
        await service.from("memberships").delete().eq("user_id", staffUserId);
        await service.auth.admin.deleteUser(staffUserId);
      }
      await service.from("stores").delete().eq("id", STORE_B);
      await service.from("product_variants").update(variant2Defaults).eq("id", VARIANT_2);
      await service.from("product_variants").update(variantDefaults).eq("id", VARIANT_1);
      await service.from("products").update(productDefaults).eq("id", PRODUCT_1);
      await service.from("products").update(productDefaults).eq("id", PRODUCT_2);
      await service.from("tables").update(tableDefaults).eq("id", TABLE_1);
      await service.from("stores").update(storeDefaults).eq("id", STORE_A);
    }
    if (owner) {
      await owner.auth.signOut();
    }
  });

  /** item ของ PRODUCT_1 (45 = base 45 + variant 0 + modifier 0) */
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

  /** item ของ PRODUCT_2 (55 = base 55 + variant 0 + modifier 0 — group บังคับเลือก 1) */
  function makeUntrackedItems(quantity: number) {
    return [
      {
        product_id: PRODUCT_2,
        product_name: "ลาเต้",
        variant_id: VARIANT_2,
        variant_name: "เล็ก (S)",
        modifiers: [{ option: { id: OPTION_2, name: "ไม่หวาน", priceAdjustment: 0 } }],
        quantity,
        unit_price: 55,
        total_price: 55 * quantity,
        note: null,
      },
    ];
  }

  /** submit QR order แบบ N lines (qty 1 ต่อ line) เพื่อให้ได้ item ครบ N แถว */
  async function submitQrOrder(
    orderNumber: string,
    lineCount: number,
    itemsFactory: (n: number) => ReturnType<typeof makeItems> = makeItems,
  ): Promise<string> {
    const lines = Array.from({ length: lineCount }, (_, i) => ({ ...itemsFactory(1)[0]!, note: `line-${i}` }));
    const subtotal = lines.reduce((sum, line) => sum + line.total_price, 0);
    const requestHash = computeRequestHash({ storeId: STORE_A, tableId: TABLE_1, subtotal, items: lines });
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: ORG_A,
      p_store_id: STORE_A,
      p_table_id: TABLE_1,
      p_order_number: orderNumber,
      p_operation_key: createOperationKey(),
      p_request_hash: requestHash,
      p_subtotal: subtotal,
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

  async function fetchOrder(orderId: string): Promise<{
    status: string;
    prep_status: string;
    revision: number;
    paid_at: string | null;
    subtotal: number;
    discount: number;
    total: number;
  }> {
    const { data, error } = await service
      .from("orders")
      .select("status, prep_status, revision, paid_at, subtotal, discount, total")
      .eq("id", orderId)
      .single();
    expect(error).toBeNull();
    return data as {
      status: string;
      prep_status: string;
      revision: number;
      paid_at: string | null;
      subtotal: number;
      discount: number;
      total: number;
    };
  }

  async function fetchStock(variantId: string): Promise<number | null> {
    const { data, error } = await service.from("product_variants").select("stock_quantity").eq("id", variantId).single();
    expect(error).toBeNull();
    return (data as { stock_quantity: number | null }).stock_quantity;
  }

  async function callReject(input: {
    storeId?: string;
    orderId: string;
    itemId: string;
    actorUserId?: string | null;
    reason?: string | null;
    operationKey?: string;
    requestHash?: string;
  }): Promise<GovernedOutcome<RejectResult>> {
    const operationKey = input.operationKey ?? createOperationKey();
    createdReceiptKeys.push(operationKey);
    const { data, error } = await service.rpc("unified_pos_reject_order_item", {
      p_organization_id: ORG_A,
      p_store_id: input.storeId ?? STORE_A,
      p_order_id: input.orderId,
      p_item_id: input.itemId,
      p_operation_key: operationKey,
      p_request_hash:
        input.requestHash ??
        computeRequestHash({ storeId: STORE_A, orderId: input.orderId, itemId: input.itemId, reason: input.reason ?? null }),
      p_actor_user_id: input.actorUserId === undefined ? OWNER_ID : input.actorUserId,
      p_reason: input.reason ?? null,
    });
    expect(error, `RPC unified_pos_reject_order_item ต้องไม่ throw: ${error?.message}`).toBeNull();
    return data as GovernedOutcome<RejectResult>;
  }

  async function callWrapperVoid(input: {
    storeId: string;
    orderId: string;
    itemId: string;
    reason?: string | null;
  }): Promise<{ error: { message: string } | null }> {
    createdReceiptKeys.push(`legacy_void:${input.itemId}`);
    const { error } = await owner.rpc("void_qr_order_item", {
      p_store_id: input.storeId,
      p_order_id: input.orderId,
      p_item_id: input.itemId,
      p_reason: input.reason ?? null,
    });
    return { error: error as { message: string } | null };
  }

  it("reject จากทุก state (new/preparing/ready/served) + recalc totals ทุก step + คืนสต๊อกครบ", { timeout: 120_000 }, async () => {
    const stockBefore = (await fetchStock(VARIANT_1))!;
    const orderId = await submitQrOrder(`U6-${runId}-STATES`, 4);
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore - 4);

    const items = await fetchItems(orderId);
    expect(items).toHaveLength(4);
    const firstId = items[0]!.id;
    const secondId = items[1]!.id;
    const thirdId = items[2]!.id;
    const fourthId = items[3]!.id;

    /** ดึง version ล่าสุดของ item ก่อน move ทุกครั้ง */
    const fresh = async (itemId: string) => {
      const rows = await fetchItems(orderId);
      return rows.find((r) => r.id === itemId)!;
    };
    const move = async (itemId: string, target: string) => {
      const row = await fresh(itemId);
      const { data, error } = await service.rpc("unified_pos_update_item_fulfillment", {
        p_organization_id: ORG_A,
        p_store_id: STORE_A,
        p_order_id: orderId,
        p_item_id: itemId,
        p_expected_fulfillment_version: row.fulfillment_version,
        p_target_fulfillment_status: target,
        p_operation_key: createOperationKey(),
        p_request_hash: computeRequestHash({ orderId, itemId, target, expectedVersion: row.fulfillment_version }),
        p_actor_user_id: OWNER_ID,
      });
      expect(error).toBeNull();
      return data as GovernedOutcome<RejectResult>;
    };

    // เตรียมสถานะต่างกัน 4 แบบ: preparing / ready / served / new
    expect((await move(firstId, "preparing")).status).toBe("executed");
    expect((await move(secondId, "preparing")).status).toBe("executed");
    expect((await move(secondId, "ready")).status).toBe("executed");
    expect((await move(thirdId, "preparing")).status).toBe("executed");
    expect((await move(thirdId, "ready")).status).toBe("executed");
    expect((await move(thirdId, "served")).status).toBe("executed");

    // reject ทีละรายการ — ทุก state reject ได้ + subtotal ลดตามจริง
    let outcome = await callReject({ orderId, itemId: firstId, reason: "ของหมด" });
    expect(outcome.status).toBe("executed");
    let result = (outcome as Extract<GovernedOutcome<RejectResult>, { status: "executed" }>).result;
    expect(result.order_status).toBe("open");
    expect(result.stock_restored_quantity).toBe(1);
    expect((await fetchOrder(orderId)).subtotal).toBe(135);

    outcome = await callReject({ orderId, itemId: secondId, reason: "ของไหม้" });
    expect(outcome.status).toBe("executed");
    expect((await fetchOrder(orderId)).subtotal).toBe(90);

    outcome = await callReject({ orderId, itemId: thirdId });
    expect(outcome.status).toBe("executed");
    // canonical void: fulfillment_status คงเดิม (ห้ามใช้ fulfillment_status='voided')
    const servedRow = (await fetchItems(orderId)).find((r) => r.id === thirdId)!;
    expect(servedRow.fulfillment_status).toBe("served");
    expect(servedRow.voided).toBe(true);
    expect((await fetchOrder(orderId)).subtotal).toBe(45);

    outcome = await callReject({ orderId, itemId: fourthId, reason: "สั่งผิด" });
    expect(outcome.status).toBe("executed");
    result = (outcome as Extract<GovernedOutcome<RejectResult>, { status: "executed" }>).result;
    expect(result.order_status).toBe("cancelled");
    expect(result.order_prep_status).toBe("done");
    const order = await fetchOrder(orderId);
    expect(order.status).toBe("cancelled");
    expect(order.prep_status).toBe("done");
    expect(order.subtotal).toBe(0);
    expect(order.total).toBe(0);

    // คืนสต๊อกครบ 4 ชิ้น (พอดีที่หักตอน submit)
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore);
  });

  it("already-voided + concurrent double-reject → executed 1 + up_invalid_item และคืนสต๊อกครั้งเดียว", { timeout: 120_000 }, async () => {
    const stockBefore = (await fetchStock(VARIANT_1))!;
    const orderId = await submitQrOrder(`U6-${runId}-RACE`, 2);
    const items = await fetchItems(orderId);
    const targetId = items[0]!.id;

    const results = await Promise.all([
      callReject({ orderId, itemId: targetId, reason: "ของหมด" }),
      callReject({ orderId, itemId: targetId, reason: "ของหมด" }),
      callReject({ orderId, itemId: targetId, reason: "ของหมด" }),
    ]);

    const executed = results.filter((r) => r.status === "executed");
    const alreadyVoided = results.filter((r) => r.status === "error" && (r as { code: string }).code === UNIFIED_POS_ERROR_CODES.invalid_item);
    expect(executed).toHaveLength(1);
    expect(alreadyVoided).toHaveLength(results.length - 1);
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore - 1);

    // ยิงซ้ำหลัง settle ด้วย key ใหม่ → ยังต้องโดน voided guard และสต๊อกไม่เพิ่ม
    const again = await callReject({ orderId, itemId: targetId, reason: "ของหมด" });
    expect(again.status).toBe("error");
    expect((again as Extract<GovernedOutcome<RejectResult>, { status: "error" }>).code).toBe(UNIFIED_POS_ERROR_CODES.invalid_item);
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore - 1);
  });

  it("order paid/closed → up_invalid_state_transition โดยไม่ void และไม่คืนสต๊อก", { timeout: 60_000 }, async () => {
    const stockBefore = (await fetchStock(VARIANT_1))!;
    const paid = await submitQrOrder(`U6-${runId}-PAID`, 1);
    const [paidItem] = await fetchItems(paid);
    const { error: paidErr } = await service
      .from("orders")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("id", paid);
    expect(paidErr).toBeNull();

    const rejected = await callReject({ orderId: paid, itemId: paidItem!.id });
    expect(rejected.status).toBe("error");
    expect((rejected as Extract<GovernedOutcome<RejectResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.invalid_state_transition,
    );
    expect((await fetchItems(paid))[0]!.voided).toBe(false);
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore - 1);

    const closed = await submitQrOrder(`U6-${runId}-CLOSED`, 1);
    const [closedItem] = await fetchItems(closed);
    const { error: closeErr } = await service.from("orders").update({ status: "cancelled" }).eq("id", closed);
    expect(closeErr).toBeNull();
    const rejectedClosed = await callReject({ orderId: closed, itemId: closedItem!.id });
    expect(rejectedClosed.status).toBe("error");
    expect((rejectedClosed as Extract<GovernedOutcome<RejectResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.invalid_state_transition,
    );
  });

  it("tracked vs untracked: tracked คืนสต๊อก / untracked ไม่แตะสต๊อก", { timeout: 120_000 }, async () => {
    const stockBefore = (await fetchStock(VARIANT_1))!;
    const tracked = await submitQrOrder(`U6-${runId}-TRACKED`, 1);
    const [trackedItem] = await fetchItems(tracked);
    const outcome = await callReject({ orderId: tracked, itemId: trackedItem!.id, reason: "ของหมด" });
    expect(outcome.status).toBe("executed");
    expect(
      (outcome as Extract<GovernedOutcome<RejectResult>, { status: "executed" }>).result.stock_restored_quantity,
    ).toBe(1);
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore);

    // untracked (seed: track_stock=false, stock null) — reject สำเร็จแต่ไม่มีการ restore
    const untracked = await submitQrOrder(`U6-${runId}-UNTRACKED`, 1, makeUntrackedItems);
    const [untrackedItem] = await fetchItems(untracked);
    const outcome2 = await callReject({ orderId: untracked, itemId: untrackedItem!.id, reason: "ของหมด" });
    expect(outcome2.status).toBe("executed");
    expect(
      (outcome2 as Extract<GovernedOutcome<RejectResult>, { status: "executed" }>).result.stock_restored_quantity,
    ).toBe(0);
    expect(await fetchStock(VARIANT_2)).toBeNull();
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore);
  });

  it("totals + discount recalc: subtotal ลดตาม, discount คงเดิม, total = subtotal - discount, รายการสุดท้าย → cancelled", { timeout: 120_000 }, async () => {
    const orderId = await submitQrOrder(`U6-${runId}-MONEY`, 2);
    const { error: discErr } = await service.from("orders").update({ discount: 20 }).eq("id", orderId);
    expect(discErr).toBeNull();

    const items = await fetchItems(orderId);
    let outcome = await callReject({ orderId, itemId: items[0]!.id });
    expect(outcome.status).toBe("executed");
    let money = await fetchOrder(orderId);
    expect(money.status).toBe("open");
    expect(money.subtotal).toBe(45);
    expect(money.discount).toBe(20);
    expect(money.total).toBe(25);

    outcome = await callReject({ orderId, itemId: items[1]!.id });
    expect(outcome.status).toBe("executed");
    money = await fetchOrder(orderId);
    expect(money.status).toBe("cancelled");
    expect(money.prep_status).toBe("done");
    expect(money.subtotal).toBe(0);
    expect(money.discount).toBe(20);
    expect(money.total).toBe(0);
  });

  it("idempotency: same key+hash → replayed / same key ต่าง hash → hash_conflict", { timeout: 60_000 }, async () => {
    const stockBefore = (await fetchStock(VARIANT_1))!;
    const orderId = await submitQrOrder(`U6-${runId}-IDEM`, 1);
    const [item] = await fetchItems(orderId);
    const operationKey = createOperationKey();
    const requestHash = computeRequestHash({ storeId: STORE_A, orderId, itemId: item!.id, reason: "ของหมด" });
    createdReceiptKeys.push(operationKey);

    const first = await callReject({ orderId, itemId: item!.id, reason: "ของหมด", operationKey, requestHash });
    expect(first.status).toBe("executed");
    const firstResult = (first as Extract<GovernedOutcome<RejectResult>, { status: "executed" }>).result;

    const replay = await callReject({ orderId, itemId: item!.id, reason: "ของหมด", operationKey, requestHash });
    expect(replay.status).toBe("replayed");
    expect((replay as Extract<GovernedOutcome<RejectResult>, { status: "replayed" }>).result?.item_id).toBe(firstResult.item_id);

    const conflict = await callReject({
      orderId,
      itemId: item!.id,
      reason: "ของหมด",
      operationKey,
      requestHash: computeRequestHash({ storeId: STORE_A, orderId, itemId: item!.id, reason: "เหตุผลอื่น" }),
    });
    expect(conflict.status).toBe("hash_conflict");

    // void เพียงครั้งเดียว + สต๊อกคืนครั้งเดียว
    expect((await fetchItems(orderId))[0]!.voided).toBe(true);
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore);
  });

  it("cross-store denial: order ของ store A เรียกผ่าน store B → up_not_found โดยไม่ mutate", { timeout: 60_000 }, async () => {
    const { error: storeErr } = await service
      .from("stores")
      .insert({
        id: STORE_B,
        organization_id: ORG_A,
        name: "U6 Store B",
        slug: `u6-store-b-${runId}`,
        is_active: true,
        unified_pos_enabled: true,
      });
    expect(storeErr, `สร้าง store B ต้องสำเร็จ: ${storeErr?.message}`).toBeNull();

    const stockBefore = (await fetchStock(VARIANT_1))!;
    const orderId = await submitQrOrder(`U6-${runId}-XSTORE`, 1);
    const [item] = await fetchItems(orderId);

    const outcome = await callReject({ storeId: STORE_B, orderId, itemId: item!.id });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<GovernedOutcome<RejectResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.not_found,
    );
    expect((await fetchItems(orderId))[0]!.voided).toBe(false);
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore - 1);
  });

  it("no permission: ไม่มี membership / staff role (ไม่มี orders.manage_qr) → up_forbidden", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U6-${runId}-PERM`, 1);
    const [item] = await fetchItems(orderId);

    // 1) actor ไม่มี membership เลย
    const outsider = await callReject({ orderId, itemId: item!.id, actorUserId: "00000000-0000-0000-0000-000000000099" });
    expect(outsider.status).toBe("error");
    expect((outsider as Extract<GovernedOutcome<RejectResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.forbidden,
    );

    // 2) actor เป็น staff (มี pos.use แต่ไม่มี orders.manage_qr — key เดียวกับ action layer)
    const staff = await callReject({ orderId, itemId: item!.id, actorUserId: staffUserId! });
    expect(staff.status).toBe("error");
    expect((staff as Extract<GovernedOutcome<RejectResult>, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.forbidden,
    );

    expect((await fetchItems(orderId))[0]!.voided).toBe(false);
  });

  it("flag off → up_store_flag_disabled (fail closed)", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U6-${runId}-FLAG`, 1);
    const [item] = await fetchItems(orderId);

    const { error: flagErr } = await service.from("stores").update({ unified_pos_enabled: false }).eq("id", STORE_A);
    expect(flagErr).toBeNull();
    try {
      const disabled = await callReject({ orderId, itemId: item!.id });
      expect(disabled.status).toBe("error");
      expect((disabled as Extract<GovernedOutcome<RejectResult>, { status: "error" }>).code).toBe(
        UNIFIED_POS_ERROR_CODES.store_flag_disabled,
      );
    } finally {
      await service.from("stores").update({ unified_pos_enabled: true }).eq("id", STORE_A);
    }
    expect((await fetchItems(orderId))[0]!.voided).toBe(false);
  });

  it("legacy wrapper: flag on → canonical path (receipt legacy_void:*) / retry replay / flag off → legacy body", { timeout: 120_000 }, async () => {
    const stockBefore = (await fetchStock(VARIANT_1))!;
    const orderId = await submitQrOrder(`U6-${runId}-WRAP`, 2);
    const items = await fetchItems(orderId);
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore - 2);

    // flag on → wrapper route เข้า unified_pos_reject_order_item (owner เป็น authenticated caller)
    let wrapper = await callWrapperVoid({ storeId: STORE_A, orderId, itemId: items[0]!.id, reason: "ของหมด" });
    expect(wrapper.error, `wrapper void ต้องสำเร็จ: ${wrapper.error?.message}`).toBeNull();
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore - 1);
    expect((await fetchOrder(orderId)).subtotal).toBe(45);

    const { data: receipt, error: receiptErr } = await service
      .from("unified_pos_operation_receipts")
      .select("operation_type, operation_key, request_hash, result")
      .eq("store_id", STORE_A)
      .eq("operation_key", `legacy_void:${items[0]!.id}`)
      .single();
    expect(receiptErr).toBeNull();
    expect(receipt!.operation_type).toBe("item_reject");

    // retry เดิม (same key + same hash ที่ derive จาก payload เดิม) → replayed → ไม่ error
    wrapper = await callWrapperVoid({ storeId: STORE_A, orderId, itemId: items[0]!.id, reason: "ของหมด" });
    expect(wrapper.error).toBeNull();
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore - 1);

    // รายการที่สอง → order ไม่เหลือ active → cancelled
    wrapper = await callWrapperVoid({ storeId: STORE_A, orderId, itemId: items[1]!.id });
    expect(wrapper.error, `wrapper void 2 ต้องสำเร็จ: ${wrapper.error?.message}`).toBeNull();
    const wrappedOrder = await fetchOrder(orderId);
    expect(wrappedOrder.status).toBe("cancelled");
    expect(wrappedOrder.prep_status).toBe("done");

    // flag off → wrapper รัน legacy body เดิม (คืนสต๊อก + recalc + cancel โดยไม่มี receipt)
    // (STORE_B อาจถูกสร้างไว้แล้วจากเคส cross-store — ถ้ายังไม่มีค่อยสร้าง แล้วปิด flag ชั่วคราว)
    const { data: existingB } = await service.from("stores").select("id").eq("id", STORE_B).maybeSingle();
    if (!existingB) {
      const { error: sbErr } = await service.from("stores").insert({
        id: STORE_B,
        organization_id: ORG_A,
        name: "U6 Store B Legacy",
        slug: `u6-store-b-legacy-${runId}`,
        is_active: true,
        unified_pos_enabled: false,
      });
      expect(sbErr, `สร้าง store B (flag off) ต้องสำเร็จ: ${sbErr?.message}`).toBeNull();
    }
    const { error: sbFlagErr } = await service.from("stores").update({ unified_pos_enabled: false }).eq("id", STORE_B);
    expect(sbFlagErr).toBeNull();
    try {
      const { error: v2Err } = await service
        .from("product_variants")
        .update({ track_stock: true, stock_quantity: 7 })
        .eq("id", VARIANT_2);
      expect(v2Err).toBeNull();

      const legacyStockBefore = (await fetchStock(VARIANT_2))!;
      const { data: legacyOrder, error: legacyOrderErr } = await service
        .from("orders")
        .insert({
          organization_id: ORG_A,
          store_id: STORE_B,
          order_number: `U6-${runId}-LEGACY`,
          status: "open",
          subtotal: 55,
          discount: 0,
          total: 55,
          qr_order_source: true,
        })
        .select("id")
        .single();
      expect(legacyOrderErr).toBeNull();
      createdOrderIds.push(legacyOrder!.id);
      const { error: legacyItemErr } = await service.from("order_items").insert({
        order_id: legacyOrder!.id,
        product_id: PRODUCT_2,
        product_name: "ลาเต้",
        variant_id: VARIANT_2,
        quantity: 1,
        unit_price: 55,
        total_price: 55,
      });
      expect(legacyItemErr).toBeNull();
      const { data: legacyItem } = await service
        .from("order_items")
        .select("id")
        .eq("order_id", legacyOrder!.id)
        .single();

      wrapper = await callWrapperVoid({ storeId: STORE_B, orderId: legacyOrder!.id, itemId: legacyItem!.id, reason: "ของหมด" });
      expect(wrapper.error, `legacy void ต้องสำเร็จ: ${wrapper.error?.message}`).toBeNull();
      expect(await fetchStock(VARIANT_2)).toBe(legacyStockBefore + 1);
      const legacyAfter = await fetchOrder(legacyOrder!.id);
      expect(legacyAfter.status).toBe("cancelled");
      expect(legacyAfter.subtotal).toBe(0);

      const { data: legacyReceipt } = await service
        .from("unified_pos_operation_receipts")
        .select("operation_key")
        .eq("store_id", STORE_B)
        .eq("operation_key", `legacy_void:${legacyItem!.id}`)
        .maybeSingle();
      expect(legacyReceipt).toBeNull(); // legacy path ไม่เขียน receipt
    } finally {
      await service.from("stores").update({ unified_pos_enabled: true }).eq("id", STORE_B);
    }
  });

  it("receipt + audit ถูกบันทึกสำหรับทุก reject ที่ executed", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U6-${runId}-AUDIT`, 1);
    const [item] = await fetchItems(orderId);
    const operationKey = createOperationKey();
    createdReceiptKeys.push(operationKey);
    const outcome = await callReject({ orderId, itemId: item!.id, operationKey, reason: "ตรวจสอบ" });
    expect(outcome.status).toBe("executed");

    const { data: receipt, error: receiptErr } = await service
      .from("unified_pos_operation_receipts")
      .select("operation_type, targets, payload")
      .eq("store_id", STORE_A)
      .eq("operation_key", operationKey)
      .single();
    expect(receiptErr).toBeNull();
    expect(receipt!.operation_type).toBe("item_reject");
    expect(JSON.stringify(receipt!.targets)).toContain(item!.id);
    expect(JSON.stringify(receipt!.payload)).toContain("ตรวจสอบ");

    const { data: audits, error: auditErr } = await service
      .from("audit_logs")
      .select("action, request_id")
      .eq("action", "unified_pos.item_reject")
      .eq("request_id", operationKey);
    expect(auditErr).toBeNull();
    expect(audits).toHaveLength(1);
  });
});
