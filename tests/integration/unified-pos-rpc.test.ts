import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  UNIFIED_POS_ERROR_CODES,
  type UnifiedPosOperationOutcome,
} from "@/modules/unified-pos/contracts";
import { computeRequestHash, createOperationKey } from "@/modules/unified-pos/envelope";
import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// Task U4 — RPC v2 integration กับ local Supabase (v0.35.4)
// ต้องตั้ง env ก่อนรัน (ขาด = skip ทั้ง describe เพื่อไม่พังตอน npm test ทั่วไป):
//   LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และต้อง `supabase db reset` หลังเพิ่ม migration 20260901000002 ก่อนรัน
//
// Fixture ร้าน seed (seed.sql):
//   org aaaaaaaa-...-0001 / store cccccccc-...-0001 / table eeeeeeee-...-0001
//   product 22222222-...-0001 (กาแฟดำ base 45 + variant + required modifier)
//   variant 33333333-...-0001 (adj 0) / option 55555555-...-0001 (adj 0)
//   owner@demo.local / demo1234 (org-level owner → pos.use ผ่าน)
//
// เคสตามแผน U4 (RED):
//   20 concurrent first orders (key ต่างกัน) / 20 concurrent same-key replay /
//   same-key ต่าง hash → conflict / stock shortage → rollback สมบูรณ์ /
//   flag false → up_store_flag_disabled / auto-open failure → up_session_not_active /
//   staff add-items → source=false + ไม่หักสต๊อกตอนสร้าง + up_forbidden

const envReady =
  !!process.env.LOCAL_SUPABASE_URL &&
  !!process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY &&
  !!process.env.LOCAL_SUPABASE_SERVICE_KEY;

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_A = "cccccccc-0000-0000-0000-000000000001";
const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
const PRODUCT_1 = "22222222-0000-0000-0000-000000000001";
const VARIANT_1 = "33333333-0000-0000-0000-000000000001";
const OPTION_1 = "55555555-0000-0000-0000-000000000001";
const STATION_NAME = "U4 Integration Station";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_EMAIL = "owner@demo.local";
const OWNER_PASSWORD = "demo1234";

type V2Result = {
  order_id: string;
  order_number: string;
  table_id: string;
  table_number: string | null;
  subtotal: number;
  revision: number;
};
type V2Outcome =
  | { status: "executed"; result: V2Result }
  | { status: "replayed"; result: V2Result | null }
  | { status: "hash_conflict" }
  | { status: "error"; code: string; message: string };

describe.skipIf(!envReady)("unified-pos-rpc integration (U4, local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;
  let owner: SupabaseClient;
  let runId: string;
  let stationId: string | null = null;
  const createdOrderIds: string[] = [];
  const createdOrderNumbers: string[] = [];

  /** fixture ที่เปลี่ยนจาก seed — afterAll ต้องคืนค่ากลับ */
  const storeDefaults = { unified_pos_enabled: false, table_open_policy: "staff_only" };
  const tableDefaults = { qr_enabled: false, session_started_at: null, session_expires_at: null };
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

    // --- fixture: เปิด flag/policy/qr + station + stock ---
    const { error: storeErr } = await service
      .from("stores")
      .update({ unified_pos_enabled: true, qr_ordering_enabled: true, table_open_policy: "customer_self" })
      .eq("id", STORE_A);
    expect(storeErr, `เปิด store flags ต้องสำเร็จ: ${storeErr?.message}`).toBeNull();

    const { error: tableErr } = await service
      .from("tables")
      .update({ qr_enabled: true, session_started_at: null, session_expires_at: null, status: "available" })
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
    // cleanup best-effort: order (item cascade ตาม FK) → station → คืนค่า fixture เดิม
    if (service) {
      if (createdOrderIds.length > 0) {
        await service.from("orders").delete().in("id", createdOrderIds);
      }
      if (stationId) {
        await service.from("kitchen_stations").delete().eq("id", stationId);
      }
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

  /** payload semantic สำหรับ hash (shape เดียวกับ action ฝั่ง app) */
  function makeHashPayload(subtotal: number, quantity: number, note: string | null = null) {
    return {
      storeId: STORE_A,
      tableId: TABLE_1,
      subtotal,
      items: [
        {
          productId: PRODUCT_1,
          variantId: VARIANT_1,
          modifierOptionIds: [OPTION_1],
          quantity,
          note,
        },
      ],
    };
  }

  async function callQrV2(input: {
    orderNumber: string;
    operationKey: string;
    requestHash: string;
    subtotal: number;
    items: unknown;
  }): Promise<V2Outcome> {
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: ORG_A,
      p_store_id: STORE_A,
      p_table_id: TABLE_1,
      p_order_number: input.orderNumber,
      p_operation_key: input.operationKey,
      p_request_hash: input.requestHash,
      p_subtotal: input.subtotal,
      p_items: input.items,
    });
    expect(error, `RPC create_qr_order_with_items_v2 ต้องไม่ throw: ${error?.message}`).toBeNull();
    return data as V2Outcome;
  }

  async function callStaffV2(input: {
    actorUserId: string;
    orderNumber: string;
    operationKey: string;
    requestHash: string;
    subtotal: number;
    items: unknown;
  }): Promise<V2Outcome> {
    const { data, error } = await service.rpc("add_items_to_table_v2", {
      p_organization_id: ORG_A,
      p_store_id: STORE_A,
      p_table_id: TABLE_1,
      p_actor_user_id: input.actorUserId,
      p_order_number: input.orderNumber,
      p_operation_key: input.operationKey,
      p_request_hash: input.requestHash,
      p_subtotal: input.subtotal,
      p_items: input.items,
    });
    expect(error, `RPC add_items_to_table_v2 ต้องไม่ throw: ${error?.message}`).toBeNull();
    return data as V2Outcome;
  }

  async function countOrders(orderNumber: string): Promise<number> {
    const { data, error } = await service
      .from("orders")
      .select("id", { count: "exact" })
      .eq("store_id", STORE_A)
      .eq("order_number", orderNumber);
    expect(error).toBeNull();
    return data?.length ?? 0;
  }

  it("20 concurrent first orders (key ต่างกัน) บนโต๊ะเดียว → สำเร็จทุก order, session เดียว, revision ถูกต้อง", { timeout: 120_000 }, async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const orderNumber = `U4-${runId}-C${i}`;
        createdOrderNumbers.push(orderNumber);
        return callQrV2({
          orderNumber,
          operationKey: createOperationKey(),
          requestHash: computeRequestHash(makeHashPayload(45, 1)),
          subtotal: 45,
          items: makeItems(1),
        });
      }),
    );

    for (const [i, outcome] of results.entries()) {
      expect(outcome.status, `order #${i} ต้อง executed (ได้: ${outcome.status})`).toBe("executed");
      if (outcome.status === "executed") {
        createdOrderIds.push(outcome.result.order_id);
      }
    }

    // session เดียว: auto-open เกิดครั้งเดียว (session_started_at ถูกตั้งและไม่ถูกรีเซ็ตซ้ำ)
    const { data: table, error: tableErr } = await service
      .from("tables")
      .select("session_started_at, session_expires_at")
      .eq("id", TABLE_1)
      .single();
    expect(tableErr).toBeNull();
    expect(table?.session_started_at).toBeTruthy();
    expect(Date.parse(table!.session_expires_at!)).toBeGreaterThan(Date.now());

    // 20 order + revision = 2 (insert 1 + parent bump 1) + order_number ไม่ซ้ำ
    const { data: orders, error: ordersErr } = await service
      .from("orders")
      .select("id, order_number, revision, qr_order_source, status")
      .eq("store_id", STORE_A)
      .in("order_number", createdOrderNumbers);
    expect(ordersErr).toBeNull();
    expect(orders).toHaveLength(N);
    expect(new Set(orders!.map((o) => o.order_number)).size).toBe(N);
    for (const order of orders!) {
      expect(order.revision).toBe(2);
      expect(order.qr_order_source).toBe(true);
      expect(order.status).toBe("open");
      createdOrderIds.push(order.id);
    }
  });

  it("20 concurrent same-key → executed 1 + replayed 19 + มี order เดียว", { timeout: 120_000 }, async () => {
    const N = 20;
    const orderNumber = `U4-${runId}-SAME`;
    const operationKey = createOperationKey();
    const requestHash = computeRequestHash(makeHashPayload(90, 2));

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        callQrV2({
          orderNumber,
          operationKey,
          requestHash,
          subtotal: 90,
          items: makeItems(2),
        }),
      ),
    );

    const executed = results.filter((r) => r.status === "executed");
    const replayed = results.filter((r) => r.status === "replayed");
    expect(executed).toHaveLength(1);
    expect(replayed).toHaveLength(N - 1);
    expect(results.filter((r) => r.status === "hash_conflict")).toHaveLength(0);
    expect(results.filter((r) => r.status === "error")).toHaveLength(0);

    // executed และ replayed ต้องชี้ order เดียวกัน
    const executedResult = (executed[0] as Extract<V2Outcome, { status: "executed" }>).result;
    createdOrderIds.push(executedResult.order_id);
    createdOrderNumbers.push(orderNumber);
    for (const outcome of replayed) {
      expect((outcome as Extract<V2Outcome, { status: "replayed" }>).result?.order_id).toBe(
        executedResult.order_id,
      );
    }
    expect(await countOrders(orderNumber)).toBe(1);

    // receipt มี result เดิม (อ่านผ่าน owner เพื่อพิสูจน์ RLS read ด้วย)
    const { data: receipt, error: receiptErr } = await owner
      .from("unified_pos_operation_receipts")
      .select("operation_type, request_hash, result")
      .eq("store_id", STORE_A)
      .eq("operation_key", operationKey)
      .maybeSingle();
    expect(receiptErr).toBeNull();
    expect(receipt?.operation_type).toBe("qr_submit");
    expect(receipt?.request_hash).toBe(requestHash);
    expect(receipt?.result?.order_id).toBe(executedResult.order_id);
  });

  it("same-key ต่าง hash → hash_conflict ทั้งหมด + ไม่เพิ่ม order", { timeout: 60_000 }, async () => {
    const orderNumber = `U4-${runId}-CONFLICT`;
    const operationKey = createOperationKey();

    const first = await callQrV2({
      orderNumber,
      operationKey,
      requestHash: computeRequestHash(makeHashPayload(45, 1)),
      subtotal: 45,
      items: makeItems(1),
    });
    expect(first.status).toBe("executed");
    if (first.status === "executed") createdOrderIds.push(first.result.order_id);
    createdOrderNumbers.push(orderNumber);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        callQrV2({
          orderNumber,
          operationKey,
          requestHash: computeRequestHash(makeHashPayload(135, 3, "โจมตีด้วย payload ต่าง")),
          subtotal: 135,
          items: makeItems(3),
        }),
      ),
    );
    for (const outcome of results) {
      expect(outcome.status).toBe("hash_conflict");
    }
    expect(await countOrders(orderNumber)).toBe(1);
  });

  it("stock shortage → up_stock_insufficient + rollback สมบูรณ์ (ไม่เหลือ order/item/receipt/สต๊อกเปลี่ยน)", { timeout: 60_000 }, async () => {
    const { data: before, error: beforeErr } = await service
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", VARIANT_1)
      .single();
    expect(beforeErr).toBeNull();
    const stockBefore = before!.stock_quantity as number;
    expect(stockBefore).toBeGreaterThan(0);

    const { data: ordersBefore, error: obErr } = await service
      .from("orders")
      .select("id", { count: "exact" })
      .eq("store_id", STORE_A);
    expect(obErr).toBeNull();
    const orderCountBefore = ordersBefore!.length;

    const orderNumber = `U4-${runId}-SHORT`;
    const outcome = await callQrV2({
      orderNumber,
      operationKey: createOperationKey(),
      requestHash: computeRequestHash(makeHashPayload(45 * (stockBefore + 5), stockBefore + 5)),
      subtotal: 45 * (stockBefore + 5),
      items: makeItems(stockBefore + 5),
    });

    expect(outcome.status).toBe("error");
    expect((outcome as Extract<V2Outcome, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.stock_insufficient,
    );

    const { data: after } = await service
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", VARIANT_1)
      .single();
    expect(after!.stock_quantity).toBe(stockBefore); // สต๊อกไม่เปลี่ยน
    const { data: ordersAfter } = await service
      .from("orders")
      .select("id", { count: "exact" })
      .eq("store_id", STORE_A);
    expect(ordersAfter!.length).toBe(orderCountBefore); // ไม่เหลือ order
    expect(await countOrders(orderNumber)).toBe(0);
  });

  it("สลับ flag false → up_store_flag_disabled + ไม่ mutate (replay ของ key เดิมยังได้ผลเดิม)", { timeout: 60_000 }, async () => {
    // เตรียม key ที่ execute สำเร็จก่อน — แล้วปิด flag แล้วยิงซ้ำ
    const orderNumber = `U4-${runId}-FLAG`;
    const operationKey = createOperationKey();
    const requestHash = computeRequestHash(makeHashPayload(45, 1));
    const first = await callQrV2({
      orderNumber,
      operationKey,
      requestHash,
      subtotal: 45,
      items: makeItems(1),
    });
    expect(first.status).toBe("executed");
    if (first.status === "executed") createdOrderIds.push(first.result.order_id);
    createdOrderNumbers.push(orderNumber);

    const { error: flagErr } = await service
      .from("stores")
      .update({ unified_pos_enabled: false })
      .eq("id", STORE_A);
    expect(flagErr).toBeNull();

    try {
      const firstCallNewKey = await callQrV2({
        orderNumber: `U4-${runId}-FLAG2`,
        operationKey: createOperationKey(),
        requestHash,
        subtotal: 45,
        items: makeItems(1),
      });
      expect(firstCallNewKey.status).toBe("error");
      expect((firstCallNewKey as Extract<V2Outcome, { status: "error" }>).code).toBe(
        UNIFIED_POS_ERROR_CODES.store_flag_disabled,
      );
      expect(await countOrders(`U4-${runId}-FLAG2`)).toBe(0);

      // retry ของคำขอเดิม (key เดิม) ต้องได้ replay แม้ flag ปิดอยู่
      const replay = await callQrV2({
        orderNumber,
        operationKey,
        requestHash,
        subtotal: 45,
        items: makeItems(1),
      });
      expect(replay.status).toBe("replayed");
    } finally {
      await service.from("stores").update({ unified_pos_enabled: true }).eq("id", STORE_A);
    }
  });

  it("auto-open failure: session หมดอายุ + staff_only → up_session_not_active โดยไม่แตะ session/order", { timeout: 60_000 }, async () => {
    // expire session ก่อน (กฎเดิม: staff_only ต้องแจ้งพนักงานเปิดโต๊ะ ห้ามเปิดเอง)
    const { error: expireErr } = await service
      .from("tables")
      .update({ session_expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      .eq("id", TABLE_1);
    expect(expireErr).toBeNull();

    const { error: policyErr } = await service
      .from("stores")
      .update({ table_open_policy: "staff_only" })
      .eq("id", STORE_A);
    expect(policyErr).toBeNull();

    const { data: sessionBefore } = await service
      .from("tables")
      .select("session_started_at, session_expires_at")
      .eq("id", TABLE_1)
      .single();

    try {
      const outcome = await callQrV2({
        orderNumber: `U4-${runId}-NOOPEN`,
        operationKey: createOperationKey(),
        requestHash: computeRequestHash(makeHashPayload(45, 1)),
        subtotal: 45,
        items: makeItems(1),
      });
      expect(outcome.status).toBe("error");
      expect((outcome as Extract<V2Outcome, { status: "error" }>).code).toBe(
        UNIFIED_POS_ERROR_CODES.session_not_active,
      );
      expect(await countOrders(`U4-${runId}-NOOPEN`)).toBe(0);

      const { data: sessionAfter } = await service
        .from("tables")
        .select("session_started_at, session_expires_at")
        .eq("id", TABLE_1)
        .single();
      expect(sessionAfter?.session_started_at).toBe(sessionBefore?.session_started_at);
      expect(sessionAfter?.session_expires_at).toBe(sessionBefore?.session_expires_at);
    } finally {
      await service.from("stores").update({ table_open_policy: "customer_self" }).eq("id", STORE_A);
    }
  });

  it("staff add-items: executed + qr_order_source=false + ไม่หักสต๊อกตอนสร้าง + replay + ไม่มีสิทธิ์ → up_forbidden", { timeout: 120_000 }, async () => {
    // ให้ session พร้อมเสมอ (test ก่อนหน้าอาจปล่อย session หมดอายุไว้)
    const { error: sessionErr } = await service
      .from("tables")
      .update({ session_started_at: new Date().toISOString(), session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
      .eq("id", TABLE_1);
    expect(sessionErr).toBeNull();

    const { data: stockBefore, error: sbErr } = await service
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", VARIANT_1)
      .single();
    expect(sbErr).toBeNull();

    const orderNumber = `U4-${runId}-STAFF`;
    const operationKey = createOperationKey();
    const requestHash = computeRequestHash(makeHashPayload(45, 1));

    const first = await callStaffV2({
      actorUserId: OWNER_ID,
      orderNumber,
      operationKey,
      requestHash,
      subtotal: 45,
      items: makeItems(1),
    });
    expect(first.status).toBe("executed");
    const staffOrder = (first as Extract<V2Outcome, { status: "executed" }>).result;
    createdOrderIds.push(staffOrder.order_id);
    createdOrderNumbers.push(orderNumber);

    const { data: staffOrderRow, error: soErr } = await service
      .from("orders")
      .select("qr_order_source, cashier_id, system_account_id, revision")
      .eq("id", staffOrder.order_id)
      .single();
    expect(soErr).toBeNull();
    expect(staffOrderRow!.qr_order_source).toBe(false);
    expect(staffOrderRow!.cashier_id).toBe(OWNER_ID);
    expect(staffOrderRow!.system_account_id).toBeNull();
    expect(staffOrderRow!.revision).toBe(2);

    // convention 20260607000006: staff (source=false) ห้ามหักสต๊อกตอนสร้าง — หักตอนชำระ
    const { data: stockAfter, error: saErr } = await service
      .from("product_variants")
      .select("stock_quantity")
      .eq("id", VARIANT_1)
      .single();
    expect(saErr).toBeNull();
    expect(stockAfter!.stock_quantity).toBe(stockBefore!.stock_quantity);

    // receipt + replay
    const { data: receipt, error: receiptErr } = await owner
      .from("unified_pos_operation_receipts")
      .select("operation_type")
      .eq("store_id", STORE_A)
      .eq("operation_key", operationKey)
      .maybeSingle();
    expect(receiptErr).toBeNull();
    expect(receipt?.operation_type).toBe("add_items");

    const replay = await callStaffV2({
      actorUserId: OWNER_ID,
      orderNumber,
      operationKey,
      requestHash,
      subtotal: 45,
      items: makeItems(1),
    });
    expect(replay.status).toBe("replayed");
    expect((replay as Extract<V2Outcome, { status: "replayed" }>).result?.order_id).toBe(
      staffOrder.order_id,
    );

    // actor ไม่มี membership → up_forbidden (ไม่สร้าง order)
    const forbidden = await callStaffV2({
      actorUserId: "00000000-0000-0000-0000-000000000099",
      orderNumber: `U4-${runId}-STAFF-DENY`,
      operationKey: createOperationKey(),
      requestHash,
      subtotal: 45,
      items: makeItems(1),
    });
    expect(forbidden.status).toBe("error");
    expect((forbidden as Extract<V2Outcome, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.forbidden,
    );
    expect(await countOrders(`U4-${runId}-STAFF-DENY`)).toBe(0);
  });
});
