import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { UnifiedPosTableBillView } from "@/app/pos/unified/bill-types";
import { UNIFIED_POS_ERROR_CODES } from "@/modules/unified-pos/contracts";
import {
  fetchTableBillForTable,
  parseModifierNames,
} from "@/modules/unified-pos/bill-repository";
import {
  buildReceiptJobSourceKey,
  buildReprintJobSourceKey,
  buildStationJobSourceKey,
  buildUnifiedPosReceiptReference,
  reprintUnifiedPosReceipt,
  resolveSettlementPrintIntent,
} from "@/modules/unified-pos/print-intent";
import {
  settleOrdersGoverned,
  type GovernedSettlementResponse,
} from "@/modules/unified-pos/settlement";
import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// Task U11 — settlement→print contract แบบ replay-safe (v0.37.2)
// ต้องตั้ง env ก่อนรัน (ขาด = skip ทั้ง describe เพื่อไม่พังตอน npm test ทั่วไป):
//   LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และต้องมี migration 20260901000005 + 20260902000001 ใน local DB แล้ว (supabase migration up --local)
//
// เคสตาม brief U11:
//   settle → print job ถูกสร้างด้วย source key unique (คีย์ derive จาก operation key) /
//   replay คีย์เดิม → job id ชุดเดิม ไม่มี duplicate / manual reprint มี audit row /
//   concurrent settle+print (intent พร้อมกัน) → job เดียว / station tickets → คีย์ต่อสถานี /
//   print intent ไม่ผูกกับ transaction ของ settlement (เรียกหลัง RPC สำเร็จเสมอ)
//
// หมายเหตุ env: โมดูล intent/facade อ่าน NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// ตอน call time — beforeAll ชี้ไป local stack (loopback เท่านั้น ผ่าน helper) และ afterAll คืนค่าเดิม

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
const OWNER_ID = "00000000-0000-0000-0000-000000000001";

describe.skipIf(!envReady)("unified-pos-printing integration (U11, local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;
  let runId: string;
  let stationId: string | null = null;
  let printerId: string | null = null;
  const createdOrderIds: string[] = [];
  const createdReceiptKeys: string[] = [];
  const createdSourceKeyLikes: string[] = [];
  let originalEnv: { NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SERVICE_ROLE_KEY?: string } = {};
  let originalSettings: {
    auto_print_receipt: boolean;
    auto_print_station_tickets: boolean;
    paper_width: string;
    print_copies: number;
  } | null = null;

  const storeDefaults = { unified_pos_enabled: false, qr_ordering_enabled: false, table_open_policy: "staff_only" };

  beforeAll(async () => {
    local = getLocalSupabase();
    service = local.client;
    runId = Math.random().toString(36).slice(2, 10);

    // โมดูล print-intent/settlement ใช้ service client ของแอป — ชี้ไป local stack
    // (loopback ตรวจแล้วโดย helper) เฉพาะช่วงเทสนี้ แล้วคืนค่า env เดิมใน afterAll
    originalEnv = {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
    process.env.NEXT_PUBLIC_SUPABASE_URL = local.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = local.serviceKey;

    const { error: storeErr } = await service
      .from("stores")
      .update({ unified_pos_enabled: true, qr_ordering_enabled: true, table_open_policy: "customer_self" })
      .eq("id", STORE_A);
    expect(storeErr, `เปิด store flags ต้องสำเร็จ: ${storeErr?.message}`).toBeNull();

    const { error: tableErr } = await service
      .from("tables")
      .update({
        qr_enabled: true,
        session_started_at: new Date().toISOString(),
        session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .eq("id", TABLE_1);
    expect(tableErr, `เปิด session โต๊ะต้องสำเร็จ: ${tableErr?.message}`).toBeNull();

    // เครื่องพิมพ์ IP (LAN เอกชน) + station ผูกเครื่อง — สำหรับเคส receipt/station job
    const { data: printer, error: printerErr } = await service
      .from("printers")
      .insert({
        organization_id: ORG_A,
        store_id: STORE_A,
        name: `U11 Hub Printer ${runId}`,
        type: "ip",
        is_default: true,
        ip_address: "192.168.1.250",
        port: 9100,
        paper_width: "80mm",
      })
      .select("id")
      .single();
    expect(printerErr, `สร้าง printer ต้องสำเร็จ: ${printerErr?.message}`).toBeNull();
    printerId = printer!.id;

    const { data: station, error: stationErr } = await service
      .from("kitchen_stations")
      .insert({
        organization_id: ORG_A,
        store_id: STORE_A,
        name: `U11 Integration Station ${runId}`,
        printer_id: printerId,
      })
      .select("id")
      .single();
    expect(stationErr, `สร้าง kitchen station ต้องสำเร็จ: ${stationErr?.message}`).toBeNull();
    stationId = station!.id;

    const { error: productErr } = await service
      .from("products")
      .update({ available_for_qr: true, kitchen_station_id: stationId })
      .eq("id", PRODUCT_1);
    expect(productErr, `ผูก product เข้า station ต้องสำเร็จ: ${productErr?.message}`).toBeNull();

    // receipt settings — อ่านค่าเดิมก่อน (คืนใน afterAll) แล้วเปิด auto receipt + station
    // หมายเหตุ: update เฉพาะ field ที่เทสต้องใช้เท่านั้น — ห้าม upsert (จะทับ store_name
    // และ field อื่นของแถวจริงใน local DB)
    const { data: settingsRow, error: settingsErr } = await service
      .from("receipt_settings")
      .select("auto_print_receipt, auto_print_station_tickets, paper_width, print_copies")
      .eq("store_id", STORE_A)
      .maybeSingle();
    expect(settingsErr, `อ่าน receipt_settings ต้องสำเร็จ: ${settingsErr?.message}`).toBeNull();
    expect(settingsRow, "receipt_settings ของ STORE_A ต้องมีแถวอยู่แล้ว (seed/local) — ถ้าไม่มีให้ตั้งค่าผ่าน UI ก่อน").not.toBeNull();
    originalSettings = settingsRow as {
      auto_print_receipt: boolean;
      auto_print_station_tickets: boolean;
      paper_width: string;
      print_copies: number;
    };
    const { error: settingsUpErr } = await service
      .from("receipt_settings")
      .update({
        auto_print_receipt: true,
        auto_print_station_tickets: true,
        paper_width: "80mm",
        print_copies: 1,
      })
      .eq("store_id", STORE_A);
    expect(settingsUpErr, `ตั้ง receipt_settings ต้องสำเร็จ: ${settingsUpErr?.message}`).toBeNull();
  });

  afterAll(async () => {
    // cleanup best-effort — ลบงานพิมพ์/audit/receipts/ออเดอร์ที่สร้าง + คืน fixture/env เดิม
    const failures: string[] = [];
    if (service) {
      for (const prefix of createdSourceKeyLikes) {
        const { data: jobs } = await service
          .from("print_jobs")
          .select("id")
          .eq("store_id", STORE_A)
          .like("source_key", `${prefix}%`);
        for (const job of jobs ?? []) {
          const { error } = await service.from("print_jobs").delete().eq("id", (job as { id: string }).id);
          if (error) failures.push(`print_jobs: ${error.message}`);
        }
      }
      for (const key of createdReceiptKeys) {
        await service.from("unified_pos_operation_receipts").delete().eq("operation_key", key);
        const { data: audits } = await service
          .from("audit_logs")
          .select("id")
          .or(`request_id.eq.${key},request_id.like.${buildUnifiedPosReceiptReference(key)}%`);
        for (const audit of audits ?? []) {
          const { error } = await service.from("audit_logs").delete().eq("id", (audit as { id: string }).id);
          if (error) failures.push(`audit_logs: ${error.message}`);
        }
      }
      if (createdOrderIds.length > 0) {
        await service.from("transactions").delete().in("order_id", createdOrderIds);
        await service.from("cash_ledger_entries").delete().in("order_id", createdOrderIds);
        const { error } = await service.from("orders").delete().in("id", createdOrderIds);
        if (error) failures.push(`orders: ${error.message}`);
      }
      if (originalSettings) {
        const { error } = await service.from("receipt_settings").update(originalSettings).eq("store_id", STORE_A);
        if (error) failures.push(`receipt_settings: ${error.message}`);
      }
      // คืน product ก่อนลบ station (FK products.kitchen_station_id → kitchen_stations)
      await service.from("products").update({ available_for_qr: false, kitchen_station_id: null }).eq("id", PRODUCT_1);
      if (stationId) {
        const { error } = await service.from("kitchen_stations").delete().eq("id", stationId);
        if (error) failures.push(`kitchen_stations: ${error.message}`);
      }
      if (printerId) {
        const { error } = await service.from("printers").delete().eq("id", printerId);
        if (error) failures.push(`printers: ${error.message}`);
      }
      await service
        .from("tables")
        .update({ qr_enabled: false, session_started_at: null, session_expires_at: null, status: "available" })
        .eq("id", TABLE_1);
      await service.from("stores").update(storeDefaults).eq("id", STORE_A);
    }
    process.env.NEXT_PUBLIC_SUPABASE_URL = originalEnv.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalEnv.SUPABASE_SERVICE_ROLE_KEY;
    if (failures.length > 0) {
      throw new Error(`คืนค่า fixture U11 (local) ไม่ครบ: ${failures.join(" | ")}`);
    }
  });

  /** submit QR order 1 บิล (ผ่าน RPC v2 จริง — ได้ revision/items เหมือน production) */
  async function submitQrOrder(orderNumber: string, quantity = 1): Promise<string> {
    const items = [
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
    const subtotal = 45 * quantity;
    const { computeRequestHash, createOperationKey } = await import("@/modules/unified-pos/envelope");
    const { data, error } = await service.rpc("create_qr_order_with_items_v2", {
      p_organization_id: ORG_A,
      p_store_id: STORE_A,
      p_table_id: TABLE_1,
      p_order_number: orderNumber,
      p_operation_key: createOperationKey(),
      p_request_hash: computeRequestHash({ storeId: STORE_A, tableId: TABLE_1, subtotal, items }),
      p_subtotal: subtotal,
      p_items: items,
    });
    expect(error, `submit QR ต้องไม่ throw: ${error?.message}`).toBeNull();
    const outcome = data as { status: string; result?: { order_id: string } };
    expect(outcome.status).toBe("executed");
    const orderId = outcome.result!.order_id;
    createdOrderIds.push(orderId);
    return orderId;
  }

  /** ชำระผ่าน facade จริง (เหมือนที่ settleUnifiedPosBillAction เรียก) — จด opkey ไว้ cleanup */
  async function settleFacel(input: {
    orderIds?: string[];
    mode?: "partial" | "whole_table";
    method?: "cash" | "qr_promptpay" | "credit_card" | "bank_transfer" | "other";
    amount?: number | null;
    idempotencyKey?: string;
  }): Promise<{ response: GovernedSettlementResponse; operationKey: string }> {
    const operationKey = input.idempotencyKey ?? (await import("@/modules/unified-pos/envelope")).createOperationKey();
    createdReceiptKeys.push(operationKey);
    const mode = input.mode ?? "partial";
    const orderIds = input.orderIds ?? [];
    const response = await settleOrdersGoverned({
      organizationId: ORG_A,
      storeId: STORE_A,
      mode,
      orderIds: mode === "partial" ? orderIds : undefined,
      tableId: TABLE_1,
      method: input.method ?? "qr_promptpay",
      amount: input.amount ?? null,
      actorUserId: OWNER_ID,
      idempotencyKey: operationKey,
    });
    return { response, operationKey };
  }

  async function countPrintJobs(sourceKeyPrefix: string): Promise<number> {
    const { count } = await service
      .from("print_jobs")
      .select("id", { count: "exact", head: true })
      .eq("store_id", STORE_A)
      .like("source_key", `${sourceKeyPrefix}%`);
    return count ?? 0;
  }

  /** นับ job ที่ source_key "เท่ากันเป๊ะ" (ไม่รวม reprint ที่ต่อท้าย key เดิม) */
  async function countExactSourceKey(sourceKey: string): Promise<number> {
    const { count } = await service
      .from("print_jobs")
      .select("id", { count: "exact", head: true })
      .eq("store_id", STORE_A)
      .eq("source_key", sourceKey);
    return count ?? 0;
  }

  async function listPrintJobs(sourceKeyPrefix: string): Promise<Array<{ id: string; source_key: string | null; job_kind: string | null; status: string }>> {
    const { data } = await service
      .from("print_jobs")
      .select("id, source_key, job_kind, status")
      .eq("store_id", STORE_A)
      .like("source_key", `${sourceKeyPrefix}%`);
    return (data ?? []) as Array<{ id: string; source_key: string | null; job_kind: string | null; status: string }>;
  }

  function trackReference(reference: string): void {
    createdSourceKeyLikes.push(reference);
  }

  it("บิลของโต๊ะ derive จาก server: รายการ non-voided + ยอด orders.total + parseModifierNames", async () => {
    await submitQrOrder(`U11-${runId}-BILL`);
    // production ใช้ user client (RLS) — integration test ส่ง service client ผ่าน test seam
    const bill: UnifiedPosTableBillView = await fetchTableBillForTable(STORE_A, TABLE_1, service as never);
    expect(bill.tableId).toBe(TABLE_1);
    expect(bill.orders).toHaveLength(1);
    const order = bill.orders[0]!;
    expect(order.orderNumber).toBe(`U11-${runId}-BILL`);
    expect(order.source).toBe("qr");
    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.modifierNames).toEqual(["ไม่หวาน"]);
    expect(order.total).toBe(45);
    expect(bill.grandTotal).toBe(45);

    expect(parseModifierNames([{ option: { name: "หวานน้อย" } }])).toEqual(["หวานน้อย"]);
    expect(parseModifierNames([{ name: "โดยตรง" }])).toEqual(["โดยตรง"]);
    expect(parseModifierNames(null)).toEqual([]);
    expect(parseModifierNames([42])).toEqual([]);
  });

  it("settle → intent สร้าง receipt + station job ด้วย source key จาก operation key", async () => {
    const orderId = await submitQrOrder(`U11-${runId}-P1`);
    const { response, operationKey } = await settleFacel({ orderIds: [orderId], amount: 45 });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.replayed).toBe(false);

    const intent = await resolveSettlementPrintIntent({
      organizationId: ORG_A,
      storeId: STORE_A,
      actorUserId: OWNER_ID,
      settlement: response.result,
      operationKey,
      replayed: response.replayed,
    });
    trackReference(intent.reference);
    expect(intent.reference).toBe(buildUnifiedPosReceiptReference(operationKey));

    // receipt job: 1 แถว status=pending, key = <reference>:receipt, kind=receipt
    const receiptKey = buildReceiptJobSourceKey(intent.reference);
    const receiptJobs = await listPrintJobs(receiptKey);
    expect(receiptJobs).toHaveLength(1);
    expect(receiptJobs[0]!.id).toBe(intent.receiptJobId);
    expect(receiptJobs[0]!.job_kind).toBe("receipt");
    expect(receiptJobs[0]!.status).toBe("pending");

    // station job: 1 สถานี (ทุก item ผูก station เดียว) — key = <reference>:station:<id>
    const stationKey = buildStationJobSourceKey(intent.reference, stationId!);
    const stationJobs = await listPrintJobs(stationKey);
    expect(stationJobs).toHaveLength(1);
    expect(intent.stationJobIds).toEqual([stationJobs[0]!.id]);
    expect(stationJobs[0]!.job_kind).toBe("station_ticket");
  });

  it("replay คีย์เดิม → intent คืน job id ชุดเดิม ไม่มี duplicate (receipt + station)", async () => {
    const orderId = await submitQrOrder(`U11-${runId}-REPLAY`);
    const first = await settleFacel({ orderIds: [orderId], amount: 45 });
    expect(first.response.ok).toBe(true);
    if (!first.response.ok) return;
    const firstIntent = await resolveSettlementPrintIntent({
      organizationId: ORG_A,
      storeId: STORE_A,
      actorUserId: OWNER_ID,
      settlement: first.response.result,
      operationKey: first.operationKey,
      replayed: first.response.replayed,
    });
    trackReference(firstIntent.reference);

    // retry ของคำขอเดิม (same key) → RPC replayed → intent เดิม → job id เดิม
    const replay = await settleFacel({ orderIds: [orderId], amount: 45, idempotencyKey: first.operationKey });
    expect(replay.response.ok).toBe(true);
    if (!replay.response.ok) return;
    expect(replay.response.replayed).toBe(true);
    const replayIntent = await resolveSettlementPrintIntent({
      organizationId: ORG_A,
      storeId: STORE_A,
      actorUserId: OWNER_ID,
      settlement: replay.response.result!,
      operationKey: replay.operationKey,
      replayed: replay.response.replayed,
    });
    expect(replayIntent.reference).toBe(firstIntent.reference);
    expect(replayIntent.receiptJobId).toBe(firstIntent.receiptJobId);
    expect(replayIntent.stationJobIds).toEqual(firstIntent.stationJobIds);

    const receiptKey = buildReceiptJobSourceKey(firstIntent.reference);
    expect(await countPrintJobs(receiptKey)).toBe(1);
    expect(await countPrintJobs(buildStationJobSourceKey(firstIntent.reference, stationId!))).toBe(1);
  });

  it("intent พร้อมกัน (concurrent settle+print) → job เดียวต่อ key (unique index ตัดสิน)", async () => {
    const orderId = await submitQrOrder(`U11-${runId}-CONC`);
    const { response, operationKey } = await settleFacel({ orderIds: [orderId], amount: 45 });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    trackReference(buildUnifiedPosReceiptReference(operationKey));

    const runIntent = () =>
      resolveSettlementPrintIntent({
        organizationId: ORG_A,
        storeId: STORE_A,
        actorUserId: OWNER_ID,
        settlement: response.result,
        operationKey,
        replayed: false,
      });
    const [a, b, c] = await Promise.all([runIntent(), runIntent(), runIntent()]);
    expect(a.receiptJobId).toBeTruthy();
    expect(b.receiptJobId).toBe(a.receiptJobId);
    expect(c.receiptJobId).toBe(a.receiptJobId);
    expect(await countPrintJobs(buildReceiptJobSourceKey(a.reference))).toBe(1);
  });

  it("manual reprint: คีย์ reprint:<n> ไม่ซ้ำ + audit row ทุกครั้ง + คู่ขนานได้", async () => {
    const orderId = await submitQrOrder(`U11-${runId}-REPRINT`);
    const { response, operationKey } = await settleFacel({ orderIds: [orderId], amount: 45 });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const intent = await resolveSettlementPrintIntent({
      organizationId: ORG_A,
      storeId: STORE_A,
      actorUserId: OWNER_ID,
      settlement: response.result,
      operationKey,
      replayed: false,
    });
    trackReference(intent.reference);
    expect(intent.receiptJobId).toBeTruthy();

    const reference = intent.reference;
    const first = await reprintUnifiedPosReceipt({
      organizationId: ORG_A,
      storeId: STORE_A,
      actorUserId: OWNER_ID,
      receiptReference: reference,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.jobId).not.toBe(intent.receiptJobId);
    expect(first.sourceKey).toBe(buildReprintJobSourceKey(buildReceiptJobSourceKey(reference), 1));

    // reprint ครั้งที่ 2 → คีย์ถัดไป + audit อีกแถว
    const second = await reprintUnifiedPosReceipt({
      organizationId: ORG_A,
      storeId: STORE_A,
      actorUserId: OWNER_ID,
      receiptReference: reference,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.sourceKey).toBe(buildReprintJobSourceKey(buildReceiptJobSourceKey(reference), 2));

    // audit: 1 แถวต่อ reprint (action + request_id = คีย์ reprint)
    const { data: audits } = await service
      .from("audit_logs")
      .select("id, action, request_id, actor_user_id, after")
      .eq("store_id", STORE_A)
      .eq("action", "unified_pos.reprint_receipt")
      .like("request_id", `${buildReceiptJobSourceKey(reference)}%`);
    expect(audits ?? []).toHaveLength(2);

    // คู่ขนาน: reprint พร้อมกันสองครั้ง → แต่ละคำขอได้คีย์ของตัวเอง (แพ้ race = นับใหม่
    // ไม่ dedupe ทับ — explicit action ต้องได้ job + audit ของตัวเอง)
    const [p1, p2] = await Promise.all([
      reprintUnifiedPosReceipt({ organizationId: ORG_A, storeId: STORE_A, actorUserId: OWNER_ID, receiptReference: reference }),
      reprintUnifiedPosReceipt({ organizationId: ORG_A, storeId: STORE_A, actorUserId: OWNER_ID, receiptReference: reference }),
    ]);
    expect(p1.ok).toBe(true);
    expect(p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;
    expect(p1.sourceKey).not.toBe(p2.sourceKey);
    expect(await countExactSourceKey(buildReceiptJobSourceKey(reference))).toBe(1); // ตัวต้นฉบับเดียว
    expect(await countPrintJobs(`${buildReceiptJobSourceKey(reference)}:reprint:`)).toBe(4);
    // audit ครบ 4 ครั้ง (2 sequential + 2 parallel) — request_id คีย์ละแถว
    const { data: allAudits } = await service
      .from("audit_logs")
      .select("id")
      .eq("store_id", STORE_A)
      .eq("action", "unified_pos.reprint_receipt")
      .like("request_id", `${buildReceiptJobSourceKey(reference)}%`);
    expect(allAudits ?? []).toHaveLength(4);
  });

  it("reprint อ้าง reference ที่ไม่มีงาน → up_not_found (ไม่มี job ถูกสร้าง)", async () => {
    const missing = buildUnifiedPosReceiptReference(`no-such-operation-${runId}`);
    const result = await reprintUnifiedPosReceipt({
      organizationId: ORG_A,
      storeId: STORE_A,
      actorUserId: OWNER_ID,
      receiptReference: missing,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(UNIFIED_POS_ERROR_CODES.not_found);
  });

  it("ปิด auto-print ทั้งคู่ → intent ไม่สร้าง job แต่ยังคืน reference stable", async () => {
    const orderId = await submitQrOrder(`U11-${runId}-OFF`);
    const { error } = await service
      .from("receipt_settings")
      .update({ auto_print_receipt: false, auto_print_station_tickets: false })
      .eq("store_id", STORE_A);
    expect(error).toBeNull();
    try {
      const { response, operationKey } = await settleFacel({ orderIds: [orderId], amount: 45 });
      expect(response.ok).toBe(true);
      if (!response.ok) return;
      const intent = await resolveSettlementPrintIntent({
        organizationId: ORG_A,
        storeId: STORE_A,
        actorUserId: OWNER_ID,
        settlement: response.result,
        operationKey,
        replayed: false,
      });
      trackReference(intent.reference);
      expect(intent.reference).toBe(buildUnifiedPosReceiptReference(operationKey));
      expect(intent.receiptJobId).toBeNull();
      expect(intent.stationJobIds).toEqual([]);
      expect(intent.receiptNotice).toContain("การพิมพ์อัตโนมัติปิดอยู่");
      expect(await countPrintJobs(intent.reference)).toBe(0);
    } finally {
      const { error: restoreErr } = await service
        .from("receipt_settings")
        .update({ auto_print_receipt: true, auto_print_station_tickets: true })
        .eq("store_id", STORE_A);
      expect(restoreErr).toBeNull();
    }
  });
});
