import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_POLL_INTERVAL_MS,
  UNIFIED_POS_ITEM_EVENT_FIELDS,
  createUnifiedPosItemTracker,
  parseOrderItemRealtimePayload,
  type UnifiedPosItemEvent,
} from "@/modules/unified-pos/realtime";

// Task U3 — Unified POS Realtime (v0.35.3)
// เน้น 2 กลุ่ม:
//   1) parser: แปลง RealtimePostgresChangesPayload เป็น envelope 7 field (no-leak)
//   2) tracker: dedupe ตาม version ต่อ item + reconnect snapshot + pollTick + dispose
// behavior gate ของ publication/replica identity อยู่ที่ pgTAP: supabase/tests/002_unified_pos_realtime.sql

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const STORE_A = "cccccccc-0000-0000-0000-000000000001";
const ORDER_A = "ffffffff-3333-0000-0000-000000000001";
const ITEM_A = "ffffffff-3333-0000-0000-000000000002";
const ITEM_B = "ffffffff-3333-0000-0000-000000000003";

/** สร้าง payload รูปแบบเดียวกับ supabase-js RealtimePostgresChangesPayload (postgres_changes) */
function pgPayload(eventType: "INSERT" | "UPDATE" | "DELETE", parts: { new?: Record<string, unknown>; old?: Record<string, unknown> }) {
  return {
    schema: "public",
    table: "order_items",
    commit_timestamp: "2026-09-01T00:00:00Z",
    eventType,
    errors: [],
    new: parts.new ?? {},
    old: parts.old ?? {},
  };
}

function itemRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ITEM_A,
    order_id: ORDER_A,
    product_id: "22222222-0000-0000-0000-000000000001",
    product_name: "กาแฟดำ",
    quantity: 1,
    unit_price: "45.00", // ต้องไม่ leak ออก envelope
    note: "หวานน้อย", // ต้องไม่ leak ออก envelope
    fulfillment_status: "new",
    fulfillment_version: 1,
    voided: false,
    ...overrides,
  };
}

describe("unified-pos-realtime parser (U3)", () => {
  it("INSERT: แปลง new record เป็น envelope ครบ 7 field, version เป็น number", () => {
    const event = parseOrderItemRealtimePayload(pgPayload("INSERT", { new: itemRecord() }), {
      storeId: STORE_A,
    });

    expect(event).not.toBeNull();
    expect(event).toEqual({
      storeId: STORE_A,
      orderId: ORDER_A,
      itemId: ITEM_A,
      fulfillmentVersion: 1,
      fulfillmentStatus: "new",
      voided: false,
      eventType: "INSERT",
    });
    expect(typeof event!.fulfillmentVersion).toBe("number");
  });

  it("UPDATE: อ่านจาก new record", () => {
    const event = parseOrderItemRealtimePayload(
      pgPayload("UPDATE", {
        new: itemRecord({ fulfillment_status: "preparing", fulfillment_version: 2 }),
        old: itemRecord({ fulfillment_status: "new", fulfillment_version: 1 }),
      }),
      { storeId: STORE_A },
    );

    expect(event).toEqual({
      storeId: STORE_A,
      orderId: ORDER_A,
      itemId: ITEM_A,
      fulfillmentVersion: 2,
      fulfillmentStatus: "preparing",
      voided: false,
      eventType: "UPDATE",
    });
  });

  it("DELETE: อ่าน fulfillment_version/fulfillment_status/voided จาก old record (replica identity full)", () => {
    const event = parseOrderItemRealtimePayload(
      pgPayload("DELETE", {
        new: {},
        old: itemRecord({ fulfillment_status: "ready", fulfillment_version: 3, voided: true }),
      }),
      { storeId: STORE_A },
    );

    expect(event).toEqual({
      storeId: STORE_A,
      orderId: ORDER_A,
      itemId: ITEM_A,
      fulfillmentVersion: 3,
      fulfillmentStatus: "ready",
      voided: true,
      eventType: "DELETE",
    });
  });

  it("bigint ผ่าน realtime มาเป็น string → normalize เป็น number", () => {
    const event = parseOrderItemRealtimePayload(
      pgPayload("UPDATE", { new: itemRecord({ fulfillment_version: "2" }) }),
      { storeId: STORE_A },
    );

    expect(event).not.toBeNull();
    expect(event!.fulfillmentVersion).toBe(2);
    expect(typeof event!.fulfillmentVersion).toBe("number");
  });

  it("no-leak: ผลลัพธ์มี key เท่ากับ envelope เท่านั้น (ไม่มีราคา/โน้ต/คอลัมน์อื่น)", () => {
    const event = parseOrderItemRealtimePayload(pgPayload("INSERT", { new: itemRecord() }), {
      storeId: STORE_A,
    });

    expect(event).not.toBeNull();
    expect(Object.keys(event!).sort()).toEqual([...UNIFIED_POS_ITEM_EVENT_FIELDS].sort());
    expect(event).not.toHaveProperty("unit_price");
    expect(event).not.toHaveProperty("note");
    expect(event).not.toHaveProperty("product_name");
  });

  it("storeId: มาจาก context ก่อนเสมอ และ fallback เป็น record.store_id (เผื่อ schema อนาคต)", () => {
    const fromContext = parseOrderItemRealtimePayload(
      pgPayload("INSERT", { new: itemRecord({ store_id: "cccccccc-9999" }) }),
      { storeId: STORE_A },
    );
    expect(fromContext!.storeId).toBe(STORE_A);

    const fromRecord = parseOrderItemRealtimePayload(pgPayload("INSERT", { new: itemRecord({ store_id: STORE_A }) }));
    expect(fromRecord!.storeId).toBe(STORE_A);
  });

  it("คืน null เมื่อ payload ใช้ไม่ได้/field ขาด", () => {
    const cases: unknown[] = [
      null,
      undefined,
      "INSERT",
      [],
      pgPayload("INSERT", {} as Record<string, unknown>), // INSERT ไม่มี new
      pgPayload("INSERT", { new: itemRecord({ id: "" }) }), // id ว่าง
      pgPayload("INSERT", { new: itemRecord({ id: 123 }) }), // id ไม่ใช่ string
      pgPayload("INSERT", { new: itemRecord({ order_id: null }) }), // order_id ขาด
      pgPayload("INSERT", { new: itemRecord({ fulfillment_version: 0 }) }), // version ต้อง >= 1
      pgPayload("INSERT", { new: itemRecord({ fulfillment_version: -1 }) }),
      pgPayload("INSERT", { new: itemRecord({ fulfillment_version: "abc" }) }),
      pgPayload("INSERT", { new: itemRecord({ fulfillment_version: null }) }),
      pgPayload("INSERT", { new: itemRecord({ fulfillment_status: "voided" }) }), // ห้ามมี voided ใน enum (U1)
      pgPayload("INSERT", { new: itemRecord({ fulfillment_status: "unknown" }) }),
      pgPayload("INSERT", { new: itemRecord({ fulfillment_status: 1 }) }),
      pgPayload("INSERT", { new: itemRecord({ voided: undefined }) }), // voided ขาด = payload ไม่ครบ
      pgPayload("INSERT", { new: itemRecord({ voided: "false" }) }),
      // DELETE ต้องอ่านจาก old — old ไม่มีข้อมูล = ใช้ไม่ได้
      pgPayload("DELETE", { new: itemRecord() }),
    ];
    for (const payload of cases) {
      expect(parseOrderItemRealtimePayload(payload, { storeId: STORE_A }), JSON.stringify(payload)?.slice(0, 120)).toBeNull();
    }
  });

  it("คืน null เมื่อไม่มี storeId ทั้ง context และ record", () => {
    expect(parseOrderItemRealtimePayload(pgPayload("INSERT", { new: itemRecord() }))).toBeNull();
    expect(parseOrderItemRealtimePayload(pgPayload("INSERT", { new: itemRecord() }), {})).toBeNull();
  });

  it("คืน null เมื่อ eventType ไม่ใช่ INSERT/UPDATE/DELETE (เช่น wildcard)", () => {
    expect(parseOrderItemRealtimePayload({ ...pgPayload("INSERT", { new: itemRecord() }), eventType: "*" }, { storeId: STORE_A })).toBeNull();
    expect(parseOrderItemRealtimePayload({ ...pgPayload("INSERT", { new: itemRecord() }), eventType: "unknown" }, { storeId: STORE_A })).toBeNull();
  });
});

describe("unified-pos-realtime tracker (U3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeEvent(overrides: Partial<UnifiedPosItemEvent> = {}): UnifiedPosItemEvent {
    return {
      storeId: STORE_A,
      orderId: ORDER_A,
      itemId: ITEM_A,
      fulfillmentVersion: 1,
      fulfillmentStatus: "new",
      voided: false,
      eventType: "INSERT",
      ...overrides,
    };
  }

  it("dedupe ต่อ item: เห็น version 1/2 แล้ว 1/2 ซ้ำต้องถูกทิ้ง, version 3 ผ่าน", () => {
    const propagated: UnifiedPosItemEvent[] = [];
    const tracker = createUnifiedPosItemTracker({ onItemEvent: (e) => propagated.push(e) });

    expect(tracker.handleEvent(makeEvent({ fulfillmentVersion: 1 }))).toBe(true);
    expect(tracker.handleEvent(makeEvent({ fulfillmentVersion: 2, fulfillmentStatus: "preparing", eventType: "UPDATE" }))).toBe(true);
    // stale/duplicate: version <= seen ของ item เดียวกัน
    expect(tracker.handleEvent(makeEvent({ fulfillmentVersion: 1 }))).toBe(false);
    expect(tracker.handleEvent(makeEvent({ fulfillmentVersion: 2, eventType: "UPDATE" }))).toBe(false);
    expect(tracker.handleEvent(makeEvent({ fulfillmentVersion: 3, fulfillmentStatus: "preparing", eventType: "UPDATE" }))).toBe(true);

    expect(propagated.map((e) => e.fulfillmentVersion)).toEqual([1, 2, 3]);
  });

  it("สลับ item: seen ของแต่ละ item ไม่กันกัน", () => {
    const propagated: UnifiedPosItemEvent[] = [];
    const tracker = createUnifiedPosItemTracker({ onItemEvent: (e) => propagated.push(e) });

    expect(tracker.handleEvent(makeEvent({ fulfillmentVersion: 2 }))).toBe(true);
    // item B version 1 — ต้องไม่โดน seen ของ item A กัน
    expect(tracker.handleEvent(makeEvent({ itemId: ITEM_B, fulfillmentVersion: 1 }))).toBe(true);
    // ซ้ำของ item B โดนกันเฉพาะ item B
    expect(tracker.handleEvent(makeEvent({ itemId: ITEM_B, fulfillmentVersion: 1 }))).toBe(false);
    expect(tracker.handleEvent(makeEvent({ itemId: ITEM_B, fulfillmentVersion: 2, eventType: "UPDATE" }))).toBe(true);

    expect(propagated.map((e) => e.itemId)).toEqual([ITEM_A, ITEM_B, ITEM_B]);
  });

  it("event ไม่ถูกต้อง (version < 1 ฯลฯ) ไม่ propagate", () => {
    const onItemEvent = vi.fn();
    const tracker = createUnifiedPosItemTracker({ onItemEvent });

    expect(tracker.handleEvent(makeEvent({ fulfillmentVersion: 0 }))).toBe(false);
    expect(tracker.handleEvent({ ...makeEvent(), fulfillmentStatus: "voided" as never })).toBe(false);
    expect(onItemEvent).not.toHaveBeenCalled();
  });

  it("reconnect (DISCONNECTED → SUBSCRIBED) emit snapshotRefetchRequired ครั้งเดียวต่อรอบ, connect แรกไม่นับ", () => {
    const onSnapshotRefetchRequired = vi.fn();
    const tracker = createUnifiedPosItemTracker({ onSnapshotRefetchRequired });

    // connect แรก (จากสถานะ initial) ไม่ใช่ reconnect
    tracker.setConnectionStatus("SUBSCRIBED");
    expect(onSnapshotRefetchRequired).not.toHaveBeenCalled();

    tracker.setConnectionStatus("DISCONNECTED");
    expect(onSnapshotRefetchRequired).not.toHaveBeenCalled();

    tracker.setConnectionStatus("SUBSCRIBED");
    expect(onSnapshotRefetchRequired).toHaveBeenCalledTimes(1);

    // รอบ reconnect ถัดไป — ครั้งเดียวต่อรอบ
    tracker.setConnectionStatus("DISCONNECTED");
    tracker.setConnectionStatus("DISCONNECTED"); // ซ้ำไม่เกิดผล
    tracker.setConnectionStatus("SUBSCRIBED");
    expect(onSnapshotRefetchRequired).toHaveBeenCalledTimes(2);

    tracker.dispose();
  });

  it("pollTick ทุก 5 วินาทีเมื่อไม่ SUBSCRIBED และหยุดเมื่อ SUBSCRIBED", () => {
    const onPollTick = vi.fn();
    const tracker = createUnifiedPosItemTracker({ onPollTick });

    // สถานะ initial (ยังไม่ SUBSCRIBED) ถือว่าไม่ subscribed → poll เลย
    vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS);
    expect(onPollTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS * 2);
    expect(onPollTick).toHaveBeenCalledTimes(3);

    tracker.setConnectionStatus("SUBSCRIBED");
    vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS * 4);
    expect(onPollTick).toHaveBeenCalledTimes(3); // หยุดแล้ว

    // หลุด connection → poll กลับมา
    tracker.setConnectionStatus("DISCONNECTED");
    vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS);
    expect(onPollTick).toHaveBeenCalledTimes(4);

    tracker.dispose();
  });

  it("pollIntervalMs configurable ผ่าน options", () => {
    const onPollTick = vi.fn();
    const tracker = createUnifiedPosItemTracker({ onPollTick, pollIntervalMs: 1000 });

    vi.advanceTimersByTime(1000);
    expect(onPollTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(onPollTick).toHaveBeenCalledTimes(5);

    tracker.dispose();
  });

  it("dispose: ล้าง timer และหยุด propagate ทั้งหมด", () => {
    const onPollTick = vi.fn();
    const onItemEvent = vi.fn();
    const tracker = createUnifiedPosItemTracker({ onPollTick, onItemEvent });

    vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS);
    expect(onPollTick).toHaveBeenCalledTimes(1);

    tracker.dispose();
    vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS * 3);
    expect(onPollTick).toHaveBeenCalledTimes(1); // ไม่มี tick เพิ่ม
    expect(tracker.handleEvent(makeEvent())).toBe(false); // event หลัง dispose ไม่ propagate
    expect(onItemEvent).not.toHaveBeenCalled();
  });

  it("dispose แล้ว setConnectionStatus ต้องเงียบ (ไม่ยิง snapshotRefetchRequired แม้ว่างโค้ง DISCONNECTED→SUBSCRIBED)", () => {
    const onSnapshotRefetchRequired = vi.fn();
    const onPollTick = vi.fn();
    const tracker = createUnifiedPosItemTracker({ onSnapshotRefetchRequired, onPollTick });

    tracker.dispose();
    tracker.setConnectionStatus("DISCONNECTED");
    tracker.setConnectionStatus("SUBSCRIBED");
    vi.advanceTimersByTime(DEFAULT_POLL_INTERVAL_MS * 2);

    expect(onSnapshotRefetchRequired).not.toHaveBeenCalled();
    expect(onPollTick).not.toHaveBeenCalled(); // ไม่เกิด timer ใหม่หลัง dispose
  });
});

describe("unified-pos-realtime migration (U3, lint-level gate)", () => {
  // behavior gate จริงอยู่ที่ pgTAP: supabase/tests/002_unified_pos_realtime.sql
  const migration = readFileSync(
    path.join(repoRoot, "supabase", "migrations", "20260901000001_unified_pos_realtime.sql"),
    "utf8",
  ).replace(/\s+/g, " ");

  it("migration มีไฟล์จริงและระบุ task/version ไว้ในหัวไฟล์", () => {
    expect(migration).toContain("Task U3 (v0.35.3)");
  });

  it("มี DO-block guard เช็ค pg_publication_tables ก่อน add order_items (idempotent)", () => {
    expect(migration).toContain("pg_publication_tables");
    expect(migration).toContain("pubname = 'supabase_realtime'");
    expect(migration).toContain("alter publication supabase_realtime add table public.order_items;");
  });

  it("ห้าม add table อื่นเข้า publication ใน migration นี้", () => {
    const added = migration.match(/alter publication supabase_realtime add table [a-z_.]+/g) ?? [];
    expect(added).toEqual(["alter publication supabase_realtime add table public.order_items"]);
  });

  it("ตั้ง replica identity full บน order_items", () => {
    expect(migration).toContain("alter table public.order_items replica identity full;");
  });
});
