import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UNIFIED_POS_ERROR_CODES } from "@/modules/unified-pos/contracts";
import { computeRequestHash, createOperationKey } from "@/modules/unified-pos/envelope";
import { buildSettlementRequestHash, type SettlementMode } from "@/modules/unified-pos/settlement";
import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// Task U7 — governed dine-in table settlement + payment/rewards idempotency (v0.35.7)
// ต้องตั้ง env ก่อนรัน (ขาด = skip ทั้ง describe เพื่อไม่พังตอน npm test ทั่วไป):
//   LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และต้องมี migration 20260901000005 ใน local DB ก่อนรัน (supabase migration up --local)
//
// Fixture ร้าน seed (seed.sql): org/store/table/product/variant/option + owner@demo.local
// เคสตาม brief U7:
//   replay same key+hash → ผลเดิม ไม่มี payment/reward ซ้ำ / same key+hash ต่าง → conflict /
//   partial ไม่ปิดบิลอื่น / stale revision → up_stale_version /
//   concurrent double settlement → reward โพสต์ครั้งเดียว (winner + replayed/conflict) /
//   payment failure → rollback ทั้งก้อน / reward ตามกฎ legacy (round, settings, default) /
//   cross-store → up_not_found / no permission → up_forbidden / flag off →
//   up_store_flag_disabled / derived status = done หลัง settle
// เพิ่มจากข้อบกพร่องที่แก้ใน migration: cash gate (session + cashflow.record),
//   staff order หักสต๊อก quantity × unit_quantity, autocreate หมวด 'ยอดขาย POS'

const envReady =
  !!process.env.LOCAL_SUPABASE_URL &&
  !!process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY &&
  !!process.env.LOCAL_SUPABASE_SERVICE_KEY;

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_A = "cccccccc-0000-0000-0000-000000000001";
const STORE_B = "cccccccc-0000-0000-0000-0000000000b1";
const STORE_C = "cccccccc-0000-0000-0000-0000000000c1";
const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
const TABLE_2 = "eeeeeeee-0000-0000-0000-000000000002";
const PRODUCT_1 = "22222222-0000-0000-0000-000000000001";
const VARIANT_1 = "33333333-0000-0000-0000-000000000001";
const PRODUCT_2 = "22222222-0000-0000-0000-000000000002";
const VARIANT_2 = "33333333-0000-0000-0000-000000000003";
const OPTION_1 = "55555555-0000-0000-0000-000000000001";
const STATION_NAME = "U7 Integration Station";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";
const OUTSIDER_ID = "00000000-0000-0000-0000-000000000099";
const OWNER_EMAIL = "owner@demo.local";
const OWNER_PASSWORD = "demo1234";
const CUSTOMER_1 = "77777777-0000-0000-0000-000000000001";
const CUSTOMER_2 = "77777777-0000-0000-0000-000000000002";

type SettleOutcome =
  | {
      status: "executed";
      result: {
        mode: string;
        table_id: string | null;
        table_closed: boolean;
        order_ids: string[];
        grand_total: number;
        payments: { order_id: string; payment_id: string; amount: number; received_amount: number; change_amount: number }[];
        orders: { order_id: string; status: string; prep_status: string; revision: number; points_earned: number }[];
      };
    }
  | { status: "replayed"; result: SettleResult | null }
  | { status: "hash_conflict" }
  | { status: "error"; code: string; message: string };

type SettleResult = {
  mode: string;
  table_id: string | null;
  table_closed: boolean;
  order_ids: string[];
  grand_total: number;
  payments: { order_id: string; payment_id: string; amount: number; received_amount: number; change_amount: number }[];
  orders: { order_id: string; status: string; prep_status: string; revision: number; points_earned: number }[];
};

describe.skipIf(!envReady)("unified-pos-settlement integration (U7, local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;
  let owner: SupabaseClient;
  let runId: string;
  let stationId: string | null = null;
  let staffUserId: string | null = null;
  let staffMembershipId: string | null = null;
  const createdOrderIds: string[] = [];
  const createdReceiptKeys: string[] = [];

  const storeDefaults = { unified_pos_enabled: false, qr_ordering_enabled: false, table_open_policy: "staff_only" };
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

    const { error: storeErr } = await service
      .from("stores")
      .update({ unified_pos_enabled: true, qr_ordering_enabled: true, table_open_policy: "customer_self" })
      .eq("id", STORE_A);
    expect(storeErr, `เปิด store flags ต้องสำเร็จ: ${storeErr?.message}`).toBeNull();

    const openSession = async (tableId: string) => {
      const { error: tableErr } = await service
        .from("tables")
        .update({
          qr_enabled: true,
          session_started_at: new Date().toISOString(),
          session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
        .eq("id", tableId);
      expect(tableErr, `เปิด session ของโต๊ะต้องสำเร็จ: ${tableErr?.message}`).toBeNull();
    };
    await openSession(TABLE_1);
    await openSession(TABLE_2);

    const { data: station, error: stationErr } = await service
      .from("kitchen_stations")
      .insert({ organization_id: ORG_A, store_id: STORE_A, name: `${STATION_NAME} ${runId}` })
      .select("id")
      .single();
    expect(stationErr, `สร้าง kitchen station ต้องสำเร็จ: ${stationErr?.message}`).toBeNull();
    stationId = station!.id;

    for (const productId of [PRODUCT_1, PRODUCT_2]) {
      const { error: productErr } = await service
        .from("products")
        .update({ available_for_qr: true, kitchen_station_id: stationId })
        .eq("id", productId);
      expect(productErr, `เปิด available_for_qr + station ต้องสำเร็จ: ${productErr?.message}`).toBeNull();
    }

    const { error: variantErr } = await service
      .from("product_variants")
      .update({ track_stock: true, stock_quantity: 50 })
      .eq("id", VARIANT_1);
    expect(variantErr, `ตั้งสต๊อก variant 1 ต้องสำเร็จ: ${variantErr?.message}`).toBeNull();

    // customers สำหรับทดสอบ reward (settings/default rate)
    for (const [id, name] of [
      [CUSTOMER_1, "U7 Customer 1"],
      [CUSTOMER_2, "U7 Customer 2"],
    ] as const) {
      const { error: customerErr } = await service.from("customers").insert({
        id,
        organization_id: ORG_A,
        store_id: STORE_A,
        name,
        is_active: true,
      });
      expect(customerErr, `สร้าง customer ต้องสำเร็จ: ${customerErr?.message}`).toBeNull();
    }

    // staff user (role staff — มี pos.use + cashflow.record ตาม role matrix)
    const { data: created, error: userErr } = await service.auth.admin.createUser({
      email: `u7-staff-${runId}@demo.local`,
      password: "demo1234",
      email_confirm: true,
    });
    expect(userErr, `สร้าง staff user ต้องสำเร็จ: ${userErr?.message}`).toBeNull();
    staffUserId = created!.user!.id;
    const { data: membership, error: memberErr } = await service
      .from("memberships")
      .insert({
        organization_id: ORG_A,
        store_id: null,
        user_id: staffUserId,
        role: "staff",
        joined_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    expect(memberErr, `สร้าง membership staff ต้องสำเร็จ: ${memberErr?.message}`).toBeNull();
    staffMembershipId = membership!.id;
  });

  afterAll(async () => {
    // cleanup best-effort (ลำดับตาม FK: transactions/ledger → orders → receipts/audit →
    // loyalty → sessions → stores/users → คืนค่า fixture)
    if (service) {
      if (createdOrderIds.length > 0) {
        await service.from("transactions").delete().in("order_id", createdOrderIds);
        await service.from("cash_ledger_entries").delete().in("order_id", createdOrderIds);
      }
      if (createdOrderIds.length > 0) {
        await service.from("orders").delete().in("id", createdOrderIds);
      }
      for (const key of createdReceiptKeys) {
        await service.from("unified_pos_operation_receipts").delete().eq("operation_key", key);
        await service.from("audit_logs").delete().eq("request_id", key);
      }
      await service.from("loyalty_ledger").delete().eq("store_id", STORE_A);
      await service.from("loyalty_accounts").delete().eq("store_id", STORE_A);
      await service.from("loyalty_settings").delete().eq("store_id", STORE_A);
      await service.from("cash_sessions").delete().in("store_id", [STORE_A, STORE_C]);
      if (stationId) {
        await service.from("kitchen_stations").delete().eq("id", stationId);
      }
      if (staffUserId) {
        await service.from("memberships").delete().eq("user_id", staffUserId);
        await service.auth.admin.deleteUser(staffUserId);
      }
      await service.from("stores").delete().eq("id", STORE_B);
      await service.from("stores").delete().eq("id", STORE_C);
      await service.from("customers").delete().in("id", [CUSTOMER_1, CUSTOMER_2]);
      await service.from("product_variants").update(variantDefaults).eq("id", VARIANT_2);
      await service.from("product_variants").update(variantDefaults).eq("id", VARIANT_1);
      await service.from("products").update(productDefaults).eq("id", PRODUCT_1);
      await service.from("products").update(productDefaults).eq("id", PRODUCT_2);
      await service.from("tables").update(tableDefaults).eq("id", TABLE_2);
      await service.from("tables").update(tableDefaults).eq("id", TABLE_1);
      await service.from("stores").update(storeDefaults).eq("id", STORE_A);
    }
    if (owner) {
      await owner.auth.signOut();
    }
  });

  /** item ของ PRODUCT_1 (45 = base 45 + variant 0 + modifier 0) — ใช้สร้าง QR order */
  function makeQrItems(quantity: number) {
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

  /** submit QR order (qr_order_source=true — สต๊อกหักตอนสร้าง) */
  async function submitQrOrder(orderNumber: string, quantity = 1): Promise<string> {
    const items = makeQrItems(quantity);
    const subtotal = items.reduce((sum, item) => sum + item.total_price, 0);
    const requestHash = computeRequestHash({ storeId: STORE_A, tableId: TABLE_1, subtotal, items });
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: ORG_A,
      p_store_id: STORE_A,
      p_table_id: TABLE_1,
      p_order_number: orderNumber,
      p_operation_key: createOperationKey(),
      p_request_hash: requestHash,
      p_subtotal: subtotal,
      p_items: items,
    });
    expect(error, `submit QR ต้องไม่ throw: ${error?.message}`).toBeNull();
    const outcome = data as { status: string; result?: { order_id: string } };
    expect(outcome.status).toBe("executed");
    const orderId = (outcome as { status: "executed"; result: { order_id: string } }).result.order_id;
    createdOrderIds.push(orderId);
    return orderId;
  }

  /** insert staff order ตรง (qr_order_source=false — สต๊อกหักตอนชำระ) + item แบบกำหนดเอง */
  async function insertStaffOrder(input: {
    storeId?: string;
    tableId?: string | null;
    total: number;
    customerId?: string | null;
    variantId?: string | null;
    quantity?: number;
    unitQuantity?: number;
    orderNumber: string;
  }): Promise<string> {
    const { data: order, error: orderErr } = await service
      .from("orders")
      .insert({
        organization_id: ORG_A,
        store_id: input.storeId ?? STORE_A,
        order_number: input.orderNumber,
        status: "open",
        table_id: input.tableId ?? null,
        subtotal: input.total,
        discount: 0,
        total: input.total,
        qr_order_source: false,
        customer_id: input.customerId ?? null,
      })
      .select("id")
      .single();
    expect(orderErr, `สร้าง staff order ต้องสำเร็จ: ${orderErr?.message}`).toBeNull();
    createdOrderIds.push(order!.id);
    const quantity = input.quantity ?? 1;
    const unitQuantity = input.unitQuantity ?? 1;
    const { error: itemErr } = await service.from("order_items").insert({
      order_id: order!.id,
      product_id: PRODUCT_2,
      product_name: "ลาเต้",
      variant_id: input.variantId ?? null,
      quantity,
      unit_quantity: unitQuantity,
      unit_price: input.total / quantity,
      total_price: input.total,
    });
    expect(itemErr, `สร้าง order item ต้องสำเร็จ: ${itemErr?.message}`).toBeNull();
    return order!.id;
  }

  async function readRevisions(orderIds: string[]): Promise<Record<string, number>> {
    const { data, error } = await service
      .from("orders")
      .select("id, revision")
      .in("id", orderIds);
    expect(error).toBeNull();
    const map: Record<string, number> = {};
    for (const row of data ?? []) {
      map[(row as { id: string }).id] = (row as { revision: number }).revision;
    }
    return map;
  }

  /** derive ชุดบิล open ของโต๊ะ (เหมือน facade — sorted created_at asc) */
  async function deriveTableOrders(tableId: string): Promise<{ id: string; revision: number; total: number }[]> {
    const { data, error } = await service
      .from("orders")
      .select("id, revision, total")
      .eq("store_id", STORE_A)
      .eq("table_id", tableId)
      .eq("status", "open")
      .is("paid_at", null)
      .order("created_at", { ascending: true });
    expect(error).toBeNull();
    return (data ?? []) as { id: string; revision: number; total: number }[];
  }

  /** เรียก RPC settle โดยอ่าน revision จาก DB เอง (เหมือน facade) */
  async function callSettle(input: {
    storeId?: string;
    tableId?: string | null;
    mode: SettlementMode;
    orderIds?: string[];
    method: "cash" | "qr_promptpay" | "credit_card" | "bank_transfer" | "other";
    amount?: number;
    receivedAmount?: number | null;
    changeAmount?: number | null;
    reference?: string | null;
    actorUserId?: string;
    operationKey?: string;
    requestHash?: string;
    staleRevisions?: boolean;
  }): Promise<SettleOutcome> {
    let orderIds = [...(input.orderIds ?? [])];
    let amount = input.amount ?? 0;
    let tableId = input.tableId ?? null;

    if (input.mode === "whole_table") {
      const rows = await deriveTableOrders(tableId!);
      orderIds = rows.map((r) => r.id);
      amount = Math.round(rows.reduce((sum, r) => sum + r.total, 0) * 100) / 100;
    }

    let expected = await readRevisions(orderIds);
    if (input.staleRevisions) {
      expected = Object.fromEntries(Object.entries(expected).map(([id, rev]) => [id, rev - 1]));
    }

    const operationKey = input.operationKey ?? createOperationKey();
    createdReceiptKeys.push(operationKey);
    const requestHash =
      input.requestHash ??
      buildSettlementRequestHash({
        storeId: input.storeId ?? STORE_A,
        tableId,
        mode: input.mode,
        orderIds,
        method: input.method,
        amount,
        receivedAmount: input.receivedAmount ?? null,
        changeAmount: input.changeAmount ?? null,
        reference: input.reference ?? null,
      });

    const { data, error } = await service.rpc("unified_pos_settle_table_order", {
      p_organization_id: ORG_A,
      p_store_id: input.storeId ?? STORE_A,
      p_table_id: tableId,
      p_mode: input.mode,
      p_order_ids: input.mode === "whole_table" ? null : orderIds,
      p_expected_revisions: expected,
      p_operation_key: operationKey,
      p_request_hash: requestHash,
      p_actor_user_id: input.actorUserId ?? OWNER_ID,
      p_method: input.method,
      p_amount: amount,
      p_received_amount: input.receivedAmount ?? null,
      p_change_amount: input.changeAmount ?? null,
      p_reference: input.reference ?? null,
    });
    expect(error, `RPC unified_pos_settle_table_order ต้องไม่ throw: ${error?.message}`).toBeNull();
    return data as SettleOutcome;
  }

  async function fetchOrder(orderId: string): Promise<{
    status: string;
    prep_status: string;
    revision: number;
    paid_at: string | null;
    total: number;
    loyalty_points_earned: number | null;
  }> {
    const { data, error } = await service
      .from("orders")
      .select("status, prep_status, revision, paid_at, total, loyalty_points_earned")
      .eq("id", orderId)
      .single();
    expect(error).toBeNull();
    return data as {
      status: string;
      prep_status: string;
      revision: number;
      paid_at: string | null;
      total: number;
      loyalty_points_earned: number | null;
    };
  }

  async function countPayments(orderId: string): Promise<number> {
    const { data, error } = await service.from("payments").select("id").eq("order_id", orderId);
    expect(error).toBeNull();
    return (data ?? []).length;
  }

  async function countLedger(orderId: string): Promise<number> {
    const { data, error } = await service.from("loyalty_ledger").select("id").eq("order_id", orderId);
    expect(error).toBeNull();
    return (data ?? []).length;
  }

  async function fetchStock(variantId: string): Promise<number | null> {
    const { data, error } = await service.from("product_variants").select("stock_quantity").eq("id", variantId).single();
    expect(error).toBeNull();
    return (data as { stock_quantity: number | null }).stock_quantity;
  }

  async function fetchAccount(customerId: string): Promise<{ points_balance: number } | null> {
    const { data, error } = await service
      .from("loyalty_accounts")
      .select("points_balance")
      .eq("store_id", STORE_A)
      .eq("customer_id", customerId)
      .maybeSingle();
    expect(error).toBeNull();
    return data as { points_balance: number } | null;
  }

  async function fetchLedger(orderId: string): Promise<{ points_delta: number; idempotency_key: string }[]> {
    const { data, error } = await service
      .from("loyalty_ledger")
      .select("points_delta, idempotency_key")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true });
    expect(error).toBeNull();
    return (data ?? []) as { points_delta: number; idempotency_key: string }[];
  }

  it("partial settle (QR order) → executed: paid + prep done + payment + income + receipt + audit + revision ตรง DB", { timeout: 120_000 }, async () => {
    const orderId = await submitQrOrder(`U7-${runId}-P1`);
    const revisions = await readRevisions([orderId]);
    const before = await fetchOrder(orderId);
    expect(before.status).toBe("open");
    expect(before.paid_at).toBeNull();

    const outcome = await callSettle({ mode: "partial", orderIds: [orderId], method: "qr_promptpay", amount: 45 });
    expect(outcome.status).toBe("executed");
    const result = (outcome as Extract<SettleOutcome, { status: "executed" }>).result;
    expect(result.table_closed).toBe(false);
    expect(result.order_ids).toEqual([orderId]);
    expect(result.grand_total).toBe(45);
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0]!.amount).toBe(45);
    expect(result.payments[0]!.order_id).toBe(orderId);
    expect(result.orders[0]!.status).toBe("paid");
    expect(result.orders[0]!.prep_status).toBe("done");
    expect(result.orders[0]!.revision).toBeGreaterThanOrEqual(revisions[orderId]! + 1);

    const after = await fetchOrder(orderId);
    expect(after.status).toBe("paid");
    expect(after.paid_at).not.toBeNull();
    expect(after.prep_status).toBe("done"); // derived status = done หลัง settle
    expect(after.revision).toBe(result.orders[0]!.revision); // revision ในผล = ค่าจริงใน DB
    expect(await countPayments(orderId)).toBe(1);

    const { data: txns } = await service
      .from("transactions")
      .select("type, amount, category_name")
      .eq("order_id", orderId);
    expect(txns).toHaveLength(1);
    expect(txns![0]!.type).toBe("income");
    expect(txns![0]!.amount).toBe(45);
    expect(txns![0]!.category_name).toBe("ยอดขาย POS");

    const key = createdReceiptKeys[createdReceiptKeys.length - 1]!;
    const { data: receipt, error: receiptErr } = await service
      .from("unified_pos_operation_receipts")
      .select("operation_type, is_financial, result")
      .eq("store_id", STORE_A)
      .eq("operation_key", key)
      .single();
    expect(receiptErr).toBeNull();
    expect(receipt!.operation_type).toBe("table_settlement");
    expect(receipt!.is_financial).toBe(true);
    expect((receipt!.result as { grand_total: number }).grand_total).toBe(45);

    const { data: audits } = await service
      .from("audit_logs")
      .select("action, request_id")
      .eq("action", "unified_pos.table_settlement")
      .eq("request_id", key);
    expect(audits).toHaveLength(1);
  });

  it("idempotency: same key+hash → replayed ผลเดิม (ไม่เพิ่ม payment/audit) / same key ต่าง hash → hash_conflict", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U7-${runId}-IDEM`);
    const operationKey = createOperationKey();
    createdReceiptKeys.push(operationKey);
    const payload = {
      storeId: STORE_A,
      tableId: TABLE_1,
      mode: "partial" as const,
      orderIds: [orderId],
      method: "other" as const,
      amount: 45,
      receivedAmount: null,
      changeAmount: null,
      reference: null,
    };
    const requestHash = buildSettlementRequestHash(payload);

    const first = await callSettle({
      mode: "partial",
      orderIds: [orderId],
      method: "other",
      amount: 45,
      operationKey,
      requestHash,
    });
    expect(first.status).toBe("executed");
    const firstResult = (first as Extract<SettleOutcome, { status: "executed" }>).result;

    const replay = await callSettle({
      mode: "partial",
      orderIds: [orderId],
      method: "other",
      amount: 45,
      operationKey,
      requestHash,
    });
    expect(replay.status).toBe("replayed");
    const replayResult = (replay as Extract<SettleOutcome, { status: "replayed" }>).result;
    expect(replayResult?.payments[0]?.payment_id).toBe(firstResult.payments[0]!.payment_id);
    expect(await countPayments(orderId)).toBe(1);
    expect(await fetchOrder(orderId)).toMatchObject({ status: "paid", prep_status: "done" });

    const conflict = await callSettle({
      mode: "partial",
      orderIds: [orderId],
      method: "other",
      amount: 44,
      operationKey,
      requestHash: buildSettlementRequestHash({ ...payload, amount: 44 }),
    });
    expect(conflict.status).toBe("hash_conflict");
    expect(await countPayments(orderId)).toBe(1);
    // replay/conflict ไม่เขียน audit ใหม่
    const { data: audits } = await service
      .from("audit_logs")
      .select("id")
      .eq("action", "unified_pos.table_settlement")
      .eq("request_id", operationKey);
    expect(audits).toHaveLength(1);
  });

  it("partial ชำระบางบิล: บิลอื่นยัง open + session โต๊ะไม่ถูกปิด", { timeout: 120_000 }, async () => {
    const orderA = await submitQrOrder(`U7-${runId}-PART-A`);
    const orderB = await submitQrOrder(`U7-${runId}-PART-B`);

    const outcome = await callSettle({ mode: "partial", orderIds: [orderA], method: "other", amount: 45, tableId: TABLE_1 });
    expect(outcome.status).toBe("executed");
    const result = (outcome as Extract<SettleOutcome, { status: "executed" }>).result;
    expect(result.table_closed).toBe(false);
    expect(result.order_ids).toEqual([orderA]);

    expect(await fetchOrder(orderA)).toMatchObject({ status: "paid", prep_status: "done" });
    const remaining = await fetchOrder(orderB);
    expect(remaining.status).toBe("open");
    expect(remaining.paid_at).toBeNull();
    expect(remaining.prep_status).not.toBe("done");

    // session โต๊ะยังเปิด (ไม่ได้ปิดเหมือน whole_table)
    const { data: table } = await service.from("tables").select("status, session_started_at").eq("id", TABLE_1).single();
    expect(table!.session_started_at).not.toBeNull();
  });

  it("stale revision → up_stale_version โดยไม่ mutate", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U7-${runId}-STALE`);
    const before = await fetchOrder(orderId);

    const outcome = await callSettle({ mode: "partial", orderIds: [orderId], method: "other", amount: 45, staleRevisions: true });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<SettleOutcome, { status: "error" }>).code).toBe(UNIFIED_POS_ERROR_CODES.stale_version);

    const after = await fetchOrder(orderId);
    expect(after.status).toBe(before.status);
    expect(after.revision).toBe(before.revision);
    expect(await countPayments(orderId)).toBe(0);
  });

  it("reward default (ไม่มี loyalty_settings): total 150 × 0.01 → round(,2) = 1.5 แต้ม (parity กับ legacy)", { timeout: 60_000 }, async () => {
    // ต้องรันก่อน test ที่ insert loyalty_settings (default rate หายหลังมี settings)
    const orderId = await insertStaffOrder({
      total: 150,
      customerId: CUSTOMER_2,
      variantId: null,
      orderNumber: `U7-${runId}-RWD-DEF`,
    });

    const outcome = await callSettle({ mode: "partial", orderIds: [orderId], method: "other", amount: 150 });
    expect(outcome.status).toBe("executed");
    const result = (outcome as Extract<SettleOutcome, { status: "executed" }>).result;
    expect(result.orders[0]!.points_earned).toBe(1.5); // round(1.5, 2) = 1.5 — แต้มทศนิยมตาม legacy

    const ledger = await fetchLedger(orderId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.points_delta).toBe(1.5);
    expect(ledger[0]!.idempotency_key).toContain(":loyalty_earn");
    expect((await fetchAccount(CUSTOMER_2))!.points_balance).toBe(1.5);
    expect((await fetchOrder(orderId)).loyalty_points_earned).toBe(1.5);
  });

  it("reward settings: earn on (ppc 1.0) → 90 แต้ม / earn off → 0 แต้ม ไม่มี ledger", { timeout: 120_000 }, async () => {
    // กันข้อมูลค้างจากรอบรันก่อนหน้าที่ crash (settings unique ต่อ store)
    await service.from("loyalty_settings").delete().eq("store_id", STORE_A);
    const { error: settingsErr } = await service.from("loyalty_settings").insert({
      organization_id: ORG_A,
      store_id: STORE_A,
      points_per_currency: 1.0,
      earn_enabled: true,
    });
    expect(settingsErr, `insert loyalty_settings ต้องสำเร็จ: ${settingsErr?.message}`).toBeNull();

    try {
      const orderOn = await insertStaffOrder({
        total: 90,
        customerId: CUSTOMER_1,
        variantId: null,
        orderNumber: `U7-${runId}-RWD-ON`,
      });
      const outcome = await callSettle({ mode: "partial", orderIds: [orderOn], method: "other", amount: 90 });
      expect(outcome.status).toBe("executed");
      expect((outcome as Extract<SettleOutcome, { status: "executed" }>).result.orders[0]!.points_earned).toBe(90);
      expect(await fetchLedger(orderOn)).toHaveLength(1);
      expect((await fetchAccount(CUSTOMER_1))!.points_balance).toBe(90);

      // earn off → 0 แต้ม ไม่มี ledger row
      const { error: offErr } = await service
        .from("loyalty_settings")
        .update({ earn_enabled: false })
        .eq("store_id", STORE_A);
      expect(offErr).toBeNull();
      const orderOff = await insertStaffOrder({
        total: 90,
        customerId: CUSTOMER_1,
        variantId: null,
        orderNumber: `U7-${runId}-RWD-OFF`,
      });
      const outcomeOff = await callSettle({ mode: "partial", orderIds: [orderOff], method: "other", amount: 90 });
      expect(outcomeOff.status).toBe("executed");
      expect((outcomeOff as Extract<SettleOutcome, { status: "executed" }>).result.orders[0]!.points_earned).toBe(0);
      expect(await fetchLedger(orderOff)).toHaveLength(0);
      expect((await fetchAccount(CUSTOMER_1))!.points_balance).toBe(90); // ไม่เปลี่ยน

      // กลับมา earn on สำหรับ test ต่อไป
      await service.from("loyalty_settings").update({ earn_enabled: true }).eq("store_id", STORE_A);
    } finally {
      // settings ยังอยู่จนจบชุด reward/concurrency (cleanup จริงใน afterAll)
    }
  });

  it("concurrent same-key ×3 → executed 1 + replayed 2; payment/reward โพสต์ครั้งเดียว", { timeout: 120_000 }, async () => {
    const orderId = await insertStaffOrder({
      total: 90,
      customerId: CUSTOMER_1,
      variantId: null,
      orderNumber: `U7-${runId}-RACE-SAME`,
    });
    const operationKey = createOperationKey();
    createdReceiptKeys.push(operationKey);
    const payload = {
      storeId: STORE_A,
      tableId: null,
      mode: "partial" as const,
      orderIds: [orderId],
      method: "other" as const,
      amount: 90,
      receivedAmount: null,
      changeAmount: null,
      reference: null,
    };
    const requestHash = buildSettlementRequestHash(payload);

    const results = await Promise.all(
      [1, 2, 3].map(() =>
        callSettle({
          mode: "partial",
          orderIds: [orderId],
          method: "other",
          amount: 90,
          operationKey,
          requestHash,
        }),
      ),
    );
    const executed = results.filter((r) => r.status === "executed");
    const replayed = results.filter((r) => r.status === "replayed");
    expect(executed).toHaveLength(1);
    expect(replayed).toHaveLength(2);

    expect(await countPayments(orderId)).toBe(1);
    expect(await countLedger(orderId)).toBe(1); // reward โพสต์ครั้งเดียว
    expect((await fetchAccount(CUSTOMER_1))!.points_balance).toBe(180); // 90 (ก่อน) + 90
  });

  it("concurrent ต่าง key ×2 → executed 1 + up_invalid_state_transition 1; reward โพสต์ครั้งเดียว", { timeout: 120_000 }, async () => {
    const orderId = await insertStaffOrder({
      total: 90,
      customerId: CUSTOMER_1,
      variantId: null,
      orderNumber: `U7-${runId}-RACE-KEY`,
    });
    const results = await Promise.all([
      callSettle({ mode: "partial", orderIds: [orderId], method: "other", amount: 90 }),
      callSettle({ mode: "partial", orderIds: [orderId], method: "other", amount: 90 }),
    ]);
    const executed = results.filter((r) => r.status === "executed");
    const errors = results.filter((r) => r.status === "error");
    expect(executed).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Extract<SettleOutcome, { status: "error" }>).code).toBe(
      UNIFIED_POS_ERROR_CODES.invalid_state_transition,
    );
    expect(await countPayments(orderId)).toBe(1);
    expect(await countLedger(orderId)).toBe(1);
    expect((await fetchAccount(CUSTOMER_1))!.points_balance).toBe(270); // +90 จากรอบนี้
  });

  it("payment failure → rollback ทั้งก้อน (ยอดไม่ตรง / cash ไม่มี session): ไม่มี payment/ledger/receipt/audit หลงเหลือ", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U7-${runId}-FAIL`);
    const before = await fetchOrder(orderId);

    // 1) ยอดไม่ตรงกับ server → up_invalid_payment
    const mismatchKey = createOperationKey();
    createdReceiptKeys.push(mismatchKey);
    const mismatch = await callSettle({
      mode: "partial",
      orderIds: [orderId],
      method: "other",
      amount: 999,
      operationKey: mismatchKey,
      requestHash: buildSettlementRequestHash({
        storeId: STORE_A,
        tableId: TABLE_1,
        mode: "partial",
        orderIds: [orderId],
        method: "other",
        amount: 999,
        receivedAmount: null,
        changeAmount: null,
        reference: null,
      }),
    });
    expect(mismatch.status).toBe("error");
    expect((mismatch as Extract<SettleOutcome, { status: "error" }>).code).toBe(UNIFIED_POS_ERROR_CODES.invalid_payment);

    // 2) cash แต่ไม่มี open cash session → error (gate ที่เพิ่มใน RPC)
    const noSessionKey = createOperationKey();
    createdReceiptKeys.push(noSessionKey);
    const noSession = await callSettle({
      mode: "partial",
      orderIds: [orderId],
      method: "cash",
      amount: 45,
      receivedAmount: 45,
      changeAmount: 0,
      operationKey: noSessionKey,
      requestHash: buildSettlementRequestHash({
        storeId: STORE_A,
        tableId: TABLE_1,
        mode: "partial",
        orderIds: [orderId],
        method: "cash",
        amount: 45,
        receivedAmount: 45,
        changeAmount: 0,
        reference: null,
      }),
    });
    expect(noSession.status).toBe("error");
    const noSessionErr = noSession as Extract<SettleOutcome, { status: "error" }>;
    expect(noSessionErr.code).toBe(UNIFIED_POS_ERROR_CODES.invalid_payment);
    expect(noSessionErr.message).toContain("รอบเงินสด");

    const after = await fetchOrder(orderId);
    expect(after.status).toBe(before.status);
    expect(after.revision).toBe(before.revision);
    expect(await countPayments(orderId)).toBe(0);
    expect(await countLedger(orderId)).toBe(0);
    const { data: receipts } = await service
      .from("unified_pos_operation_receipts")
      .select("id")
      .in("operation_key", [mismatchKey, noSessionKey]);
    expect(receipts).toHaveLength(0);
    const { data: audits } = await service
      .from("audit_logs")
      .select("id")
      .in("request_id", [mismatchKey, noSessionKey]);
    expect(audits).toHaveLength(0);
  });

  it("cash path: เปิด session แล้ว → executed + cash ledger ต่อเนื่อง + received/change", { timeout: 60_000 }, async () => {
    const orderId = await insertStaffOrder({
      total: 90,
      variantId: null,
      orderNumber: `U7-${runId}-CASH`,
    });
    const { error: sessionErr } = await service.from("cash_sessions").insert({
      organization_id: ORG_A,
      store_id: STORE_A,
      status: "open",
      opening_float: 0,
      opened_by_user_id: OWNER_ID,
    });
    expect(sessionErr, `เปิด cash session ต้องสำเร็จ: ${sessionErr?.message}`).toBeNull();

    const outcome = await callSettle({
      mode: "partial",
      orderIds: [orderId],
      method: "cash",
      amount: 90,
      receivedAmount: 100,
      changeAmount: 10,
    });
    expect(outcome.status).toBe("executed");
    const result = (outcome as Extract<SettleOutcome, { status: "executed" }>).result;
    expect(result.payments[0]!.received_amount).toBe(100);
    expect(result.payments[0]!.change_amount).toBe(10);

    const { data: ledger, error: ledgerErr } = await service
      .from("cash_ledger_entries")
      .select("type, amount, balance_after, order_id")
      .eq("order_id", orderId);
    expect(ledgerErr).toBeNull();
    expect(ledger).toHaveLength(1);
    expect(ledger![0]!.type).toBe("pos_sale");
    expect(ledger![0]!.amount).toBe(90);
    expect(ledger![0]!.balance_after).toBe(90);
    expect(ledger![0]!.order_id).toBe(orderId);
  });

  it("cash โดยไม่มีสิทธิ์ cashflow.record (override denied) → up_forbidden", { timeout: 60_000 }, async () => {
    const orderId = await insertStaffOrder({
      total: 45,
      variantId: null,
      orderNumber: `U7-${runId}-CASH-NOPERM`,
    });
    const { error: overrideErr } = await service.from("membership_permission_overrides").insert({
      membership_id: staffMembershipId!,
      organization_id: ORG_A,
      store_id: null,
      permission_key: "cashflow.record",
      granted: false,
      reason: "U7 test",
      granted_by_user_id: OWNER_ID,
    });
    expect(overrideErr, `insert override ต้องสำเร็จ: ${overrideErr?.message}`).toBeNull();
    try {
      const outcome = await callSettle({
        mode: "partial",
        orderIds: [orderId],
        method: "cash",
        amount: 45,
        receivedAmount: 45,
        changeAmount: 0,
        actorUserId: staffUserId!,
      });
      expect(outcome.status).toBe("error");
      expect((outcome as Extract<SettleOutcome, { status: "error" }>).code).toBe(UNIFIED_POS_ERROR_CODES.forbidden);
      expect(await countPayments(orderId)).toBe(0);
    } finally {
      await service.from("membership_permission_overrides").delete().eq("membership_id", staffMembershipId!);
    }
  });

  it("สต๊อก: staff order หัก quantity × unit_quantity / QR order ไม่ถูกหักซ้ำตอน settle", { timeout: 120_000 }, async () => {
    // staff order — variant 2 (track_stock=true stock 10, item 1 แถว × unit_quantity 3)
    const { error: v2Err } = await service
      .from("product_variants")
      .update({ track_stock: true, stock_quantity: 10 })
      .eq("id", VARIANT_2);
    expect(v2Err).toBeNull();
    const staffOrder = await insertStaffOrder({
      total: 165,
      variantId: VARIANT_2,
      quantity: 1,
      unitQuantity: 3,
      orderNumber: `U7-${runId}-STOCK-ST`,
    });
    const outcome = await callSettle({ mode: "partial", orderIds: [staffOrder], method: "other", amount: 165 });
    expect(outcome.status).toBe("executed");
    expect(await fetchStock(VARIANT_2)).toBe(7); // 10 - (1 × 3)

    // QR order — variant 1 หักตอน submit แล้ว; settle ไม่หักเพิ่ม
    const qrOrder = await submitQrOrder(`U7-${runId}-STOCK-QR`);
    const stockBefore = (await fetchStock(VARIANT_1))!;
    const outcomeQr = await callSettle({ mode: "partial", orderIds: [qrOrder], method: "other", amount: 45 });
    expect(outcomeQr.status).toBe("executed");
    expect(await fetchStock(VARIANT_1)).toBe(stockBefore);
  });

  it("cross-store: order ของ store A เรียกผ่าน store B (flag on) → up_not_found โดยไม่ mutate", { timeout: 60_000 }, async () => {
    const { error: storeErr } = await service.from("stores").insert({
      id: STORE_B,
      organization_id: ORG_A,
      name: "U7 Store B",
      slug: `u7-store-b-${runId}`,
      is_active: true,
      unified_pos_enabled: true,
    });
    expect(storeErr, `สร้าง store B ต้องสำเร็จ: ${storeErr?.message}`).toBeNull();

    const orderId = await submitQrOrder(`U7-${runId}-XSTORE`);
    const before = await fetchOrder(orderId);
    const outcome = await callSettle({ storeId: STORE_B, mode: "partial", orderIds: [orderId], method: "other", amount: 45 });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<SettleOutcome, { status: "error" }>).code).toBe(UNIFIED_POS_ERROR_CODES.not_found);
    const after = await fetchOrder(orderId);
    expect(after.status).toBe(before.status);
    expect(await countPayments(orderId)).toBe(0);
  });

  it("no permission: actor ไม่มี membership → up_forbidden", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U7-${runId}-PERM`);
    const outcome = await callSettle({
      mode: "partial",
      orderIds: [orderId],
      method: "other",
      amount: 45,
      actorUserId: OUTSIDER_ID,
    });
    expect(outcome.status).toBe("error");
    expect((outcome as Extract<SettleOutcome, { status: "error" }>).code).toBe(UNIFIED_POS_ERROR_CODES.forbidden);
    expect(await countPayments(orderId)).toBe(0);
  });

  it("category autocreate: ร้านที่ไม่มีหมวด income → สร้าง 'ยอดขาย POS' + บันทึก transaction", { timeout: 60_000 }, async () => {
    const { error: storeErr } = await service.from("stores").insert({
      id: STORE_C,
      organization_id: ORG_A,
      name: "U7 Store C",
      slug: `u7-store-c-${runId}`,
      is_active: true,
      unified_pos_enabled: true,
    });
    expect(storeErr, `สร้าง store C ต้องสำเร็จ: ${storeErr?.message}`).toBeNull();

    const orderId = await insertStaffOrder({
      storeId: STORE_C,
      total: 45,
      variantId: null,
      orderNumber: `U7-${runId}-CAT`,
    });
    const outcome = await callSettle({
      storeId: STORE_C,
      mode: "partial",
      orderIds: [orderId],
      method: "other",
      amount: 45,
    });
    expect(outcome.status).toBe("executed");

    const { data: category, error: catErr } = await service
      .from("accounting_categories")
      .select("name, type, is_default")
      .eq("store_id", STORE_C)
      .eq("name", "ยอดขาย POS")
      .single();
    expect(catErr).toBeNull();
    expect(category!.type).toBe("income");
    expect(category!.is_default).toBe(true);

    const { data: txns } = await service
      .from("transactions")
      .select("type, amount, category_name")
      .eq("order_id", orderId);
    expect(txns).toHaveLength(1);
    expect(txns![0]!.category_name).toBe("ยอดขาย POS");
    expect(txns![0]!.amount).toBe(45);
  });

  it("flag off → up_store_flag_disabled (fail closed)", { timeout: 60_000 }, async () => {
    const orderId = await submitQrOrder(`U7-${runId}-FLAG`);
    const { error: flagErr } = await service.from("stores").update({ unified_pos_enabled: false }).eq("id", STORE_A);
    expect(flagErr).toBeNull();
    try {
      const outcome = await callSettle({ mode: "partial", orderIds: [orderId], method: "other", amount: 45 });
      expect(outcome.status).toBe("error");
      expect((outcome as Extract<SettleOutcome, { status: "error" }>).code).toBe(
        UNIFIED_POS_ERROR_CODES.store_flag_disabled,
      );
    } finally {
      await service.from("stores").update({ unified_pos_enabled: true }).eq("id", STORE_A);
    }
    expect(await countPayments(orderId)).toBe(0);
  });

  it("whole_table: ทุกบิล paid + prep done + ปิด session โต๊ะ (derived status done)", { timeout: 120_000 }, async () => {
    // กัน order ค้างของ TABLE_2 จากรอบรันก่อนหน้า (derive ทั้งโต๊ะต้องตรงชุดที่สร้าง)
    const { data: strays } = await service
      .from("orders")
      .select("id")
      .eq("store_id", STORE_A)
      .eq("table_id", TABLE_2)
      .like("order_number", "U7-%");
    if (strays && strays.length > 0) {
      await service.from("orders").delete().in("id", strays.map((s) => (s as { id: string }).id));
    }

    // สร้าง 2 QR orders ที่ TABLE_2 แล้วชำระรวมทั้งโต๊ะ
    const orderA = await submitQrOrder(`U7-${runId}-WT-A`);
    const orderB = await submitQrOrder(`U7-${runId}-WT-B`);
    // ย้ายไป TABLE_2 เพื่อไม่ชน session ของ TABLE_1 ในเคสอื่น
    for (const id of [orderA, orderB]) {
      const { error: moveErr } = await service.from("orders").update({ table_id: TABLE_2 }).eq("id", id);
      expect(moveErr).toBeNull();
    }

    const outcome = await callSettle({ mode: "whole_table", tableId: TABLE_2, method: "qr_promptpay" });
    expect(outcome.status).toBe("executed");
    const result = (outcome as Extract<SettleOutcome, { status: "executed" }>).result;
    expect(result.table_closed).toBe(true);
    expect(result.order_ids).toEqual([orderA, orderB]);
    expect(result.grand_total).toBe(90);

    for (const id of [orderA, orderB]) {
      const order = await fetchOrder(id);
      expect(order.status).toBe("paid");
      expect(order.paid_at).not.toBeNull();
      expect(order.prep_status).toBe("done");
    }
    expect(await countPayments(orderA)).toBe(1);
    expect(await countPayments(orderB)).toBe(1);

    const { data: table } = await service.from("tables").select("status, session_started_at, session_expires_at").eq("id", TABLE_2).single();
    expect(table!.status).toBe("available");
    expect(table!.session_started_at).toBeNull();
    expect(table!.session_expires_at).toBeNull();
  });
});
