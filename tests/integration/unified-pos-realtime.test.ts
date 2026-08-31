import { randomUUID } from "node:crypto";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  UNIFIED_POS_ITEM_EVENT_FIELDS,
  createUnifiedPosItemTracker,
  parseOrderItemRealtimePayload,
  type UnifiedPosItemEvent,
} from "@/modules/unified-pos/realtime";
import { getLocalSupabase, type LocalSupabase } from "./helpers/local-supabase";

// Task U3 — Realtime integration กับ local Supabase (v0.35.3)
// ต้องตั้ง env ก่อนรัน (ขาด = skip ทั้ง describe เพื่อไม่พังตอน npm test ทั่วไป):
//   LOCAL_SUPABASE_URL / LOCAL_SUPABASE_PUBLISHABLE_KEY / LOCAL_SUPABASE_SERVICE_KEY
// และต้อง `supabase db reset` หลังเพิ่ม migration 20260901000001 ก่อนรัน
// (มิฉะนั้น order_items ยังไม่อยู่ใน publication supabase_realtime → จะไม่ได้ event)
//
// Fixture ร้าน seed (seed.sql):
//   org aaaaaaaa-0000-0000-0000-000000000001 / store cccccccc-0000-0000-0000-000000000001
//   owner@demo.local / demo1234 (org-level membership → เห็นทุก store ใน org เดียวกัน)
//   order_items ไม่มีคอลัมน์ store_id → filter ฝั่ง channel ใช้ order_id และการกันข้ามร้าน
//   พึ่ง RLS "order_items: store member can read" (orders.store_id ∈ auth_user_store_ids())

const envReady =
  !!process.env.LOCAL_SUPABASE_URL &&
  !!process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY &&
  !!process.env.LOCAL_SUPABASE_SERVICE_KEY;

const ORG_A = "aaaaaaaa-0000-0000-0000-000000000001";
const STORE_A = "cccccccc-0000-0000-0000-000000000001";
const TABLE_1 = "eeeeeeee-0000-0000-0000-000000000001";
const PRODUCT_1 = "22222222-0000-0000-0000-000000000001";
const OWNER_ID = "00000000-0000-0000-0000-000000000001";
const OWNER_EMAIL = "owner@demo.local";
const OWNER_PASSWORD = "demo1234";

const SUBSCRIBE_TIMEOUT_MS = 10_000;
const EVENT_TIMEOUT_MS = 10_000;
const ISOLATION_PROBE_MS = 4_000;

/** buffer ของ event ที่ propagate ผ่าน tracker แล้ว — รอ event ตาม predicate พร้อม timeout (ไม่ใช้ sleep ตายตัว) */
class EventBuffer {
  private events: UnifiedPosItemEvent[] = [];
  private waiters: Array<{
    predicate: (event: UnifiedPosItemEvent) => boolean;
    label: string;
    resolve: (event: UnifiedPosItemEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  push(event: UnifiedPosItemEvent): void {
    const index = this.waiters.findIndex((w) => w.predicate(event));
    if (index >= 0) {
      const waiter = this.waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    this.events.push(event);
  }

  waitFor(predicate: (event: UnifiedPosItemEvent) => boolean, label: string, timeoutMs: number): Promise<UnifiedPosItemEvent> {
    const buffered = this.events.findIndex(predicate);
    if (buffered >= 0) {
      const [event] = this.events.splice(buffered, 1);
      return Promise.resolve(event);
    }
    return new Promise<UnifiedPosItemEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timeout ${timeoutMs}ms รอ realtime event: ${label}`));
      }, timeoutMs);
      this.waiters.push({ predicate, label, resolve, reject, timer });
    });
  }

  get all(): readonly UnifiedPosItemEvent[] {
    return this.events;
  }
}

describe.skipIf(!envReady)("unified-pos-realtime integration (U3, local supabase)", () => {
  let local: LocalSupabase;
  let service: SupabaseClient;
  let owner: SupabaseClient;
  let runId: string;
  const channels: RealtimeChannel[] = [];
  const trackers: ReturnType<typeof createUnifiedPosItemTracker>[] = [];
  const createdOrderIds: string[] = [];
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    local = getLocalSupabase();
    service = local.client;

    owner = createClient(local.url, local.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await owner.auth.signInWithPassword({
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
    });
    expect(error, `signInWithPassword ของ ${OWNER_EMAIL} ต้องสำเร็จ: ${error?.message}`).toBeNull();
    expect(data.session).not.toBeNull();

    runId = randomUUID().slice(0, 8);
  });

  afterEach(async () => {
    // unsubscribe ทุก channel + dispose ทุก tracker ที่เปิดค้างไว้ (กัน listener/timer รั่วข้าม test)
    for (const channel of channels.splice(0)) {
      await owner.removeChannel(channel);
    }
    for (const tracker of trackers.splice(0)) {
      tracker.dispose();
    }
  });

  afterAll(async () => {
    // cleanup best-effort: order (item cascade ตาม FK) แล้ว org B (store/category/product cascade)
    if (service) {
      if (createdOrderIds.length > 0) {
        await service.from("orders").delete().in("id", createdOrderIds);
      }
      if (createdOrgIds.length > 0) {
        await service.from("organizations").delete().in("id", createdOrgIds);
      }
    }
    if (owner) {
      await owner.auth.signOut();
    }
  });

  /** subscribe channel postgres_changes ของ public.order_items ฝั่ง owner ผ่าน parser + tracker (pattern เดียวกับ R2 client) */
  async function subscribeOwnerToItemEvents(channelName: string, filter?: string) {
    const buffer = new EventBuffer();
    const tracker = createUnifiedPosItemTracker({ onItemEvent: (event) => buffer.push(event) });
    trackers.push(tracker);
    const channel = owner.channel(channelName);

    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "order_items", ...(filter ? { filter } : {}) },
      (payload) => {
        const event = parseOrderItemRealtimePayload(payload, { storeId: STORE_A });
        if (event) {
          tracker.handleEvent(event);
        }
      },
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`timeout ${SUBSCRIBE_TIMEOUT_MS}ms: channel ${channelName} ไม่ขึ้น SUBSCRIBED`)),
        SUBSCRIBE_TIMEOUT_MS,
      );
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timeout);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timeout);
          reject(new Error(`channel ${channelName} subscribe ไม่สำเร็จ: ${status}`));
        }
      });
    });

    channels.push(channel);
    return { channel, buffer, tracker };
  }

  async function insertOrder(input: {
    organizationId: string;
    storeId: string;
    orderNumber: string;
    /** โต๊ะของร้านนั้น — ร้าน B ส่ง null (ห้ามอ้างโต๊ะข้ามร้านแม้ schema ไม่กัน) */
    tableId: string | null;
  }): Promise<{ id: string }> {
    const { data, error } = await service
      .from("orders")
      .insert({
        organization_id: input.organizationId,
        store_id: input.storeId,
        order_number: input.orderNumber,
        status: "open",
        table_id: input.tableId,
        table_number: input.tableId ? "1" : null,
        cashier_id: OWNER_ID,
        // qr_order_source=false (POS path) เพื่อเลี่ยง machinery เฉพาะ QR
        // (trigger kitchen station อ่านจาก product แล้วทำงานปลอดภัยแม้ไม่มี station)
        qr_order_source: false,
      })
      .select("id")
      .single();
    expect(error, `insert order ${input.orderNumber} ต้องสำเร็จ: ${error?.message}`).toBeNull();
    expect(data?.id).toBeTruthy();
    createdOrderIds.push(data!.id);
    return { id: data!.id };
  }

  it("owner ได้รับ INSERT/UPDATE/UPDATE-voided ของ order_items ตามลำดับ (version 1/2/3)", { timeout: 60_000 }, async () => {
    const order = await insertOrder({ organizationId: ORG_A, storeId: STORE_A, orderNumber: `U3-${runId}-A`, tableId: TABLE_1 });

    // subscribe ก่อนเขียนข้อมูลเสมอ (กันพลาด event)
    const { buffer } = await subscribeOwnerToItemEvents(`up3-items-main-${runId}`, `order_id=eq.${order.id}`);

    const { data: item, error: itemError } = await service
      .from("order_items")
      .insert({
        order_id: order.id,
        product_id: PRODUCT_1,
        product_name: "กาแฟดำ",
        quantity: 1,
        unit_price: 45,
        total_price: 45,
      })
      .select("id, fulfillment_version, fulfillment_status, voided")
      .single();
    expect(itemError, `insert order_item ต้องสำเร็จ: ${itemError?.message}`).toBeNull();
    expect(item!.fulfillment_version).toBe(1); // truth ฝั่ง DB (trigger U2)

    const insertEvent = await buffer.waitFor(
      (e) => e.eventType === "INSERT" && e.itemId === item!.id,
      `INSERT ของ item ${item!.id}`,
      EVENT_TIMEOUT_MS,
    );
    expect(insertEvent).toEqual({
      storeId: STORE_A,
      orderId: order.id,
      itemId: item!.id,
      fulfillmentVersion: 1,
      fulfillmentStatus: "new",
      voided: false,
      eventType: "INSERT",
    });
    // no-leak: envelope มีแค่ 7 field — ราคา/โน้ตจาก row ต้องไม่หลุดมา
    expect(Object.keys(insertEvent).sort()).toEqual([...UNIFIED_POS_ITEM_EVENT_FIELDS].sort());

    // UPDATE fulfillment_status → version 2
    const { error: prepError } = await service
      .from("order_items")
      .update({ fulfillment_status: "preparing" })
      .eq("id", item!.id);
    expect(prepError).toBeNull();

    const prepEvent = await buffer.waitFor(
      (e) => e.eventType === "UPDATE" && e.itemId === item!.id && e.fulfillmentVersion === 2,
      "UPDATE version 2 (preparing)",
      EVENT_TIMEOUT_MS,
    );
    expect(prepEvent.fulfillmentStatus).toBe("preparing");
    expect(prepEvent.voided).toBe(false);
    expect(typeof prepEvent.fulfillmentVersion).toBe("number");

    // UPDATE voided=true → version 3 (canonical void ยังเป็น boolean)
    const { error: voidError } = await service
      .from("order_items")
      .update({ voided: true, voided_reason: "U3 integration test" })
      .eq("id", item!.id);
    expect(voidError).toBeNull();

    const voidEvent = await buffer.waitFor(
      (e) => e.eventType === "UPDATE" && e.itemId === item!.id && e.fulfillmentVersion === 3,
      "UPDATE version 3 (voided)",
      EVENT_TIMEOUT_MS,
    );
    expect(voidEvent.fulfillmentStatus).toBe("preparing"); // fulfillment_status คงเดิม
    expect(voidEvent.voided).toBe(true);
    expect(voidEvent.eventType).toBe("UPDATE");

    // หมายเหตุ (U3): hard-DELETE ไม่อยู่ในเกณฑ์ integration ของแผน (แผนกำหนด test insert/update/void เท่านั้น)
    // realtime ที่ bundled กับ CLI นี้ส่ง DELETE พร้อม old record เฉพาะ PK ตามที่ตรวจสอบเชิงประจักษ์
    // (แม้ตั้ง replica identity full แล้ว) — canonical flow ของแผนคือ soft-void ผ่าน boolean
    // ส่วน contract ของ parser กรณี DELETE ที่มี full-old ครอบคลุมที่ unit test แล้ว
    // และ anomaly แบบ hard-delete ฝั่ง client จะถูกจัดการด้วย snapshot refetch (R2)

    // ไม่มี event เกินมา (ทุก event ถูก consume ตรงตามลำดับที่คาด)
    expect(buffer.all).toHaveLength(0);
  });

  it("cross-store isolation: owner ของ org A ต้องไม่ได้รับ event ของ org/store B (RLS)", { timeout: 60_000 }, async () => {
    // fixture: org B + store B + category/product B แยกองค์กร — ไม่สร้าง membership ให้ owner
    // (auth_user_organization_ids อิง memberships เท่านั้น → owner ต้องมองไม่เห็นทั้ง org B)
    const orgBId = randomUUID();
    const storeBId = randomUUID();
    const categoryBId = randomUUID();
    const productBId = randomUUID();
    createdOrgIds.push(orgBId);

    for (const [table, row] of [
      ["organizations", { id: orgBId, name: `U3 Org B ${runId}`, slug: `u3-org-b-${runId}`, owner_id: OWNER_ID }],
      ["stores", { id: storeBId, organization_id: orgBId, name: "U3 Store B", slug: `u3-store-b-${runId}` }],
      ["categories", { id: categoryBId, organization_id: orgBId, store_id: storeBId, name: "U3 Category B" }],
      [
        "products",
        {
          id: productBId,
          organization_id: orgBId,
          store_id: storeBId,
          category_id: categoryBId,
          name: "U3 Product B",
          base_price: 10,
        },
      ],
    ] as const) {
      const { error } = await service.from(table).insert(row);
      expect(error, `insert fixture ${table} (org B) ต้องสำเร็จ: ${error?.message}`).toBeNull();
    }

    const orderB = await insertOrder({ organizationId: orgBId, storeId: storeBId, orderNumber: `U3-${runId}-B`, tableId: null });

    // subscribe ก่อนเขียน item เสมอ (รูปแบบเดียวกับเคสแรก) — ด้วย filter ที่แคบที่สุดของออเดอร์ B
    // ถ้า RLS ฝั่ง Realtime รั่ว event ของร้าน B จะหลุดมาถึง owner ทันที
    const { buffer } = await subscribeOwnerToItemEvents(`up3-items-isolation-${runId}`, `order_id=eq.${orderB.id}`);

    // sanity ฝั่ง RLS ปกติ (เส้นเดียวกับที่ realtime ใช้ตรวจ): owner ต้องอ่านไม่เห็นทั้ง order และ item ของ B
    const { data: seenOrders } = await owner.from("orders").select("id").eq("id", orderB.id);
    expect(seenOrders).toHaveLength(0);
    const { data: seenItems } = await owner.from("order_items").select("id").eq("order_id", orderB.id);
    expect(seenItems).toHaveLength(0);

    // เขียน item B "หลัง" subscribe — INSERT + UPDATE = มี WAL event ของร้าน B ไหลจริง
    // ระหว่างที่ owner ฟังอยู่ มิฉะนั้น assertion ลบจะผ่านทั้งที่ไม่ได้พิสูจน์อะไร
    const { data: itemB, error: itemBError } = await service
      .from("order_items")
      .insert({
        order_id: orderB.id,
        product_id: productBId,
        product_name: "U3 Product B",
        quantity: 1,
        unit_price: 10,
        total_price: 10,
      })
      .select("id, fulfillment_version")
      .single();
    expect(itemBError).toBeNull();
    expect(itemB!.fulfillment_version).toBe(1);

    const { error: voidBError } = await service
      .from("order_items")
      .update({ voided: true, voided_reason: "U3 isolation probe" })
      .eq("id", itemB!.id);
    expect(voidBError).toBeNull();

    // ไม่มี event ใดๆ ไหลเข้า tracker ภายใน ISOLATION_PROBE_MS
    await expect(buffer.waitFor(() => true, "event ของร้าน B (ต้องไม่มา)", ISOLATION_PROBE_MS)).rejects.toThrow(
      /timeout/,
    );
    expect(buffer.all).toHaveLength(0);
  });
});
