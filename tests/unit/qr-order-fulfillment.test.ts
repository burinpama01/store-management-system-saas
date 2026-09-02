import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canTransitionItemFulfillment,
  UNIFIED_POS_ERROR_CODES,
} from "@/modules/unified-pos/contracts";
import {
  planOrderPrepAdvance,
  type PrepAdvanceItemInput,
} from "@/modules/unified-pos/prep-advance";
import {
  composeStaleCancelMessage,
  CUSTOMER_STAGES,
  CUSTOMER_STAGE_LABEL,
  isCancelRejectionMessage,
  mapOrderToCustomerTimeline,
  type CustomerTimelineItemInput,
  type CustomerTimelineOrderInput,
} from "@/modules/qr-ordering/timeline";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("QR order fulfillment (#6)", () => {
  const migration = read("supabase/migrations/20260607000002_qr_order_fulfillment.sql");

  it("adds an independent kitchen prep_status to orders", () => {
    expect(migration).toContain("alter table orders");
    expect(migration).toContain("add column if not exists prep_status");
    expect(migration).toContain("check (prep_status in ('new','preparing','served','done'))");
  });

  it("defines service_requests with one-pending-per-table-type guard and RLS", () => {
    expect(migration).toContain("create table if not exists service_requests");
    expect(migration).toContain("type in ('call_staff','request_bill')");
    expect(migration).toContain("status in ('pending','resolved')");
    expect(migration).toContain("service_requests_one_pending_per_table_type");
    expect(migration).toContain("alter table service_requests enable row level security");
    expect(migration).toContain("service_requests: store member can read");
    expect(migration).toContain("service_requests: deny client insert");
    expect(migration).toContain("service_requests: cashier+ can update");
  });

  it("exposes an anon-callable RPC that validates the QR table before inserting", () => {
    expect(migration).toContain("create or replace function create_service_request");
    expect(migration).toContain("p_type not in ('call_staff','request_bill')");
    expect(migration).toContain("qr_ordering_enabled = true");
    expect(migration).toContain("qr_enabled = true");
    expect(migration).toContain("on conflict (table_id, type) where (status = 'pending')");
    expect(migration).toContain("grant execute on function create_service_request(uuid, uuid, text, text) to anon, authenticated, service_role");
  });

  it("enables realtime for orders and service_requests", () => {
    expect(migration).toContain("alter publication supabase_realtime add table orders");
    expect(migration).toContain("alter publication supabase_realtime add table service_requests");
  });

  it("wires customer + restaurant flows to the new APIs", () => {
    const customerActions = read("src/app/qr/[storeSlug]/[tableId]/actions.ts");
    expect(customerActions).toContain("getTableOrdersAction");
    expect(customerActions).toContain("requestServiceAction");
    expect(customerActions).toContain('supabase.rpc("create_service_request"');

    const repo = read("src/modules/qr-ordering/repository.ts");
    expect(repo).toContain("listActiveQrOrders");
    expect(repo).toContain("listPendingServiceRequests");
    expect(repo).toContain("updateOrderPrepStatus");
    expect(repo).toContain("resolveServiceRequest");

    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain("managedRealtimeSubscription");
    expect(board).toContain('table: "orders"');
    expect(board).toContain('table: "service_requests"');
  });
});

// ============================================================
// U5 (v0.35.5) — Item fulfillment + order prep derive (facade)
// ============================================================

describe("U5 prep-advance facade mapping", () => {
  const item = (id: string, fulfillmentStatus: PrepAdvanceItemInput["fulfillmentStatus"], voided = false): PrepAdvanceItemInput => ({
    id,
    voided,
    fulfillmentStatus,
  });

  it("target preparing: เลื่อนเฉพาะ item ที่เป็น new ทีละขั้น (preparing)", () => {
    const plan = planOrderPrepAdvance(
      [item("a", "new"), item("b", "new"), item("c", "preparing")],
      "preparing",
    );
    expect(plan).toEqual({
      kind: "advance",
      moves: [
        { itemId: "a", from: "new", to: "preparing" },
        { itemId: "b", from: "new", to: "preparing" },
      ],
    });
  });

  it("target ready: item new ต้องเลื่อนเป็น preparing เท่านั้น (ห้าม skip ข้ามขั้น)", () => {
    const plan = planOrderPrepAdvance(
      [item("a", "new"), item("b", "preparing"), item("c", "ready")],
      "ready",
    );
    expect(plan).toEqual({
      kind: "advance",
      moves: [
        { itemId: "a", from: "new", to: "preparing" },
        { itemId: "b", from: "preparing", to: "ready" },
      ],
    });
  });

  it("target served: เลื่อนทีละขั้นจากทุกสถานะก่อนหน้า (new→preparing, preparing→ready, ready→served)", () => {
    const plan = planOrderPrepAdvance(
      [item("a", "new"), item("b", "preparing"), item("c", "ready"), item("d", "served")],
      "served",
    );
    expect(plan).toEqual({
      kind: "advance",
      moves: [
        { itemId: "a", from: "new", to: "preparing" },
        { itemId: "b", from: "preparing", to: "ready" },
        { itemId: "c", from: "ready", to: "served" },
      ],
    });
  });

  it("item ที่ voided ถูกข้ามเสมอ และ item อยู่หลัง target แล้วไม่ถูกแตะ", () => {
    const plan = planOrderPrepAdvance(
      [item("v", "new", true), item("s", "served"), item("r", "ready")],
      "served",
    );
    expect(plan).toEqual({ kind: "advance", moves: [{ itemId: "r", from: "ready", to: "served" }] });
  });

  it("ทุก move ต้องผ่าน canTransitionItemFulfillment (กัน skip ที่ผิดพลาด)", () => {
    const plan = planOrderPrepAdvance([item("a", "new"), item("b", "preparing")], "served");
    expect(plan.kind).toBe("advance");
    if (plan.kind === "advance") {
      for (const move of plan.moves) {
        expect(canTransitionItemFulfillment(move.from, move.to)).toBe(true);
      }
    }
  });

  it("noop: ทุก item อยู่ที่/หลัง target แล้ว (ไม่ต้องส่ง RPC)", () => {
    expect(planOrderPrepAdvance([item("a", "served"), item("b", "ready")], "ready")).toEqual({
      kind: "noop",
    });
    expect(planOrderPrepAdvance([], "served")).toEqual({ kind: "noop" });
  });

  it("rejected: target new (ย้อนกลับ) และ target done (derive อัตโนมัติจากชำระ/ยกเลิก)", () => {
    const reverse = planOrderPrepAdvance([item("a", "preparing")], "new");
    expect(reverse.kind).toBe("rejected");
    if (reverse.kind === "rejected") {
      expect(reverse.code).toBe(UNIFIED_POS_ERROR_CODES.invalid_state_transition);
    }

    const done = planOrderPrepAdvance([item("a", "served")], "done");
    expect(done.kind).toBe("rejected");
    if (done.kind === "rejected") {
      expect(done.code).toBe(UNIFIED_POS_ERROR_CODES.invalid_state_transition);
    }
  });
});

describe("U5 transition validation (canTransitionItemFulfillment)", () => {
  it("forward chain new→preparing→ready→served เท่านั้น", () => {
    expect(canTransitionItemFulfillment("new", "preparing")).toBe(true);
    expect(canTransitionItemFulfillment("preparing", "ready")).toBe(true);
    expect(canTransitionItemFulfillment("ready", "served")).toBe(true);
  });

  it("reject reverse / skip / same / served ต่อ", () => {
    expect(canTransitionItemFulfillment("served", "ready")).toBe(false);
    expect(canTransitionItemFulfillment("ready", "preparing")).toBe(false);
    expect(canTransitionItemFulfillment("new", "ready")).toBe(false);
    expect(canTransitionItemFulfillment("new", "served")).toBe(false);
    expect(canTransitionItemFulfillment("preparing", "preparing")).toBe(false);
    expect(canTransitionItemFulfillment("served", "served")).toBe(false);
  });
});

describe("U5 governed fulfillment backend wiring", () => {
  const migration = read("supabase/migrations/20260901000003_unified_pos_fulfillment.sql");

  it("migration ใหม่เพิ่ม RPC ครบ + CHECK prep_status มี ready โดยคง done", () => {
    expect(migration).toContain("unified_pos_derive_order_prep_status");
    expect(migration).toContain("unified_pos_update_item_fulfillment");
    expect(migration).toContain("unified_pos_cancel_table_order");
    expect(migration).toContain("'ready'");
    expect(migration).toContain("'done'");
    expect(migration).toContain("orders_prep_status_ready_check");
  });

  it("RPC ต้อง grant เฉพาะ service_role (ห้าม anon/authenticated)", () => {
    expect(migration).toContain("grant execute on function public.unified_pos_update_item_fulfillment");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("revoke execute on function public.unified_pos_update_item_fulfillment");
  });

  it("types + repository: PrepStatus มี ready และ updateOrderPrepStatus route ผ่าน governed RPC", () => {
    const types = read("src/modules/qr-ordering/types.ts");
    expect(types).toContain('"ready"');

    const repo = read("src/modules/qr-ordering/repository.ts");
    expect(repo).toContain("unified_pos_enabled");
    expect(repo).toContain('rpc("unified_pos_update_item_fulfillment"');

    const action = read("src/app/(dashboard)/qr-orders/actions.ts");
    expect(action).toContain('"ready"');

    const board = read("src/app/(dashboard)/qr-orders/QrOrdersBoard.tsx");
    expect(board).toContain('ready:');
  });
});

// ============================================================
// U12 (v0.37.3) — Customer QR fulfillment timeline mapping
// (Task U12 จาก Plan v2: timeline maps received/preparing/ready/served/voided
//  + legacy rows map ปลอดภัย + cancel เฉพาะก่อนครัวรับ)
// ============================================================

describe("U12 customer timeline mapping (mapOrderToCustomerTimeline)", () => {
  const item = (
    overrides: Partial<CustomerTimelineItemInput> & { voided?: boolean } = {},
  ): CustomerTimelineItemInput => ({
    voided: false,
    ...overrides,
  });

  /** ค่าเริ่มต้น: ออเดอร์ open ยังไม่จ่าย prep 'new' รายการ new 1 ชิ้น (รูปแบบใหม่) */
  const order = (
    overrides: Partial<CustomerTimelineOrderInput> = {},
  ): CustomerTimelineOrderInput => ({
    status: "open",
    paidAt: null,
    prepStatus: "new",
    items: [item({ fulfillmentStatus: "new" })],
    ...overrides,
  });

  it("รูปแบบใหม่: item fulfillment ล้วนสถานะเดียว → stage ตรงตาม mapping received/preparing/ready/served", () => {
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "new" })] })).stage).toBe("received");
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "preparing" })] })).stage).toBe("preparing");
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "ready" })] })).stage).toBe("ready");
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "served" })] })).stage).toBe("served");
  });

  it("รูปแบบใหม่: item stage เรียงตาม index (รับ/เตรียม/พร้อม/เสิร์ฟ) และ voided มีเหตุผล", () => {
    const t = mapOrderToCustomerTimeline(
      order({
        items: [
          item({ fulfillmentStatus: "preparing" }),
          item({ voided: true, voidedReason: "ของหมด" }),
          item({ fulfillmentStatus: "ready" }),
        ],
      }),
    );
    // stage ระดับ order: ผสม preparing+ready (มี preparing) → preparing (mirror derive)
    expect(t.stage).toBe("preparing");
    expect(t.items).toEqual([
      { voided: false, stage: "preparing" },
      { voided: true, reason: "ของหมด" },
      { voided: false, stage: "ready" },
    ]);
  });

  it("รูปแบบใหม่: ผสมหลายสถานะ mirror deriveOrderPrepStatus (new+preparing→preparing, ready+served→ready, served ล้วน→served)", () => {
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "new" }), item({ fulfillmentStatus: "preparing" })] })).stage).toBe("preparing");
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "ready" }), item({ fulfillmentStatus: "served" })] })).stage).toBe("ready");
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "served" }), item({ fulfillmentStatus: "served" })] })).stage).toBe("served");
  });

  it("รูปแบบเดิม (legacy): items ไม่มี fulfillment_status → stage ตาม orders.prep_status รูปแบบเก่า", () => {
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: undefined })], prepStatus: "new" })).stage).toBe("received");
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: null })], prepStatus: "preparing" })).stage).toBe("preparing");
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: undefined })], prepStatus: "served" })).stage).toBe("served");
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: undefined })], prepStatus: "done" })).stage).toBe("closed");
  });

  it("รูปแบบเดิม: item ที่ไม่รู้สถานะแสดง stage เท่ากับระดับ order (fallback)", () => {
    const t = mapOrderToCustomerTimeline(
      order({ items: [item({ fulfillmentStatus: undefined })], prepStatus: "preparing" }),
    );
    expect(t.items).toEqual([{ voided: false, stage: "preparing" }]);
  });

  it("ช่วงผสม (migration): items นิ่งที่ default 'new' แต่ prep_status เดินหน้าแล้ว → ใช้สถานะที่ก้าวหน้าที่สุด", () => {
    // ครัว legacy เดินหน้า orders.prep_status โดย item ยังเป็นค่า default → ต้องเห็น preparing
    const legacyAdvanced = mapOrderToCustomerTimeline(
      order({ items: [item({ fulfillmentStatus: "new" })], prepStatus: "preparing" }),
    );
    expect(legacyAdvanced.stage).toBe("preparing");
    // กลับกัน: item เดินหน้าผ่าน governed RPC แต่ prep_status ยังใหม่ (trigger ยังไม่ทัน/ปิด flag)
    const itemAdvanced = mapOrderToCustomerTimeline(
      order({ items: [item({ fulfillmentStatus: "preparing" })], prepStatus: "new" }),
    );
    expect(itemAdvanced.stage).toBe("preparing");
  });

  it("order ปิด (paid/cancelled/paidAt/refunded/voided) → closed + cannot cancel", () => {
    for (const status of ["paid", "refunded", "voided", "cancelled"] as const) {
      const t = mapOrderToCustomerTimeline(order({ status }));
      expect(t.stage).toBe("closed");
      expect(t.canCancel).toBe(false);
    }
    const byPaidAt = mapOrderToCustomerTimeline(order({ status: "open", paidAt: new Date().toISOString() }));
    expect(byPaidAt.stage).toBe("closed");
    expect(byPaidAt.canCancel).toBe(false);
  });

  it("voided item: แสดงด้วยเหตุผลที่ให้ไว้ (และไม่มีเหตุผล → undefined) และไม่กระทบ stage ของออเดอร์", () => {
    const withReason = mapOrderToCustomerTimeline(
      order({ items: [item({ voided: true, voidedReason: "ลูกค้ายกเลิกเอง" })] }),
    );
    expect(withReason.items).toEqual([{ voided: true, reason: "ลูกค้ายกเลิกเอง" }]);

    const noReason = mapOrderToCustomerTimeline(
      order({ items: [item({ voided: true, voidedReason: null })] }),
    );
    expect(noReason.items).toEqual([{ voided: true, reason: undefined }]);

    // active 1 ชิ้น new + voided 1 ชิ้น → order ยัง received (voided ไม่นับเป็นสถานะเดินหน้า)
    const mixed = mapOrderToCustomerTimeline(
      order({
        items: [
          item({ fulfillmentStatus: "new" }),
          item({ voided: true, voidedReason: "ของหมด" }),
        ],
      }),
    );
    expect(mixed.stage).toBe("received");
  });

  it("canCancel gating: อนุญาตเฉพาะ open + ยังไม่จ่าย + active ล้วน new + prep ยังไม่เดินหน้า (ก่อนครัวรับ)", () => {
    // ผ่านครบเงื่อนไข
    expect(mapOrderToCustomerTimeline(order()).canCancel).toBe(true);
    // สถานะไม่ใช่ open
    expect(mapOrderToCustomerTimeline(order({ status: "pending_payment" })).canCancel).toBe(false);
    // จ่ายแล้ว
    expect(mapOrderToCustomerTimeline(order({ paidAt: new Date().toISOString() })).canCancel).toBe(false);
    // ไม่มี active item
    expect(mapOrderToCustomerTimeline(order({ items: [item({ voided: true, voidedReason: "ของหมด" })] })).canCancel).toBe(false);
    // รูปแบบใหม่: มี item ที่ครัวรับแล้ว
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "preparing" })] })).canCancel).toBe(false);
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "ready" }), item({ fulfillmentStatus: "new" })] })).canCancel).toBe(false);
    // รูปแบบเดิม: items ล้วน default แต่ prep_status เดินหน้า → ยกเลิกไม่ได้ (ตรง legacy RPC)
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: "new" })], prepStatus: "preparing" })).canCancel).toBe(false);
    // รูปแบบเดิม: prep ยัง new → ยกเลิกได้
    expect(mapOrderToCustomerTimeline(order({ items: [item({ fulfillmentStatus: undefined })], prepStatus: "new" })).canCancel).toBe(true);
  });

  it("ค่าที่ไม่รู้จัก (defensive): prep_status/fulfillment_status นอก enum ไม่พัง — fallback ปลอดภัย", () => {
    // open + ค่าทุกแหล่งไม่รู้จัก → received (การอ้างขั้นต่ำสุดที่ปลอดภัย)
    const unknown = mapOrderToCustomerTimeline(
      order({ items: [item({ fulfillmentStatus: "mystery" })], prepStatus: "mystery" }),
    );
    expect(unknown.stage).toBe("received");
    expect(unknown.items).toEqual([{ voided: false, stage: "received" }]);
    expect(unknown.canCancel).toBe(true);
  });

  it("ผลลัพธ์ leak-proof: timeline มีเฉพาะ stage/canCancel/items — ไม่มี version/operation key/actor id", () => {
    const t = mapOrderToCustomerTimeline(
      order({
        items: [
          item({ fulfillmentStatus: "preparing" }),
          item({ voided: true, voidedReason: "ของหมด" }),
        ],
      }),
    );
    const json = JSON.stringify(t);
    expect(json).not.toMatch(/fulfillment_version|operation|actor/i);
    expect(Object.keys(t).sort()).toEqual(["canCancel", "items", "stage"]);
    // type ของ stage items ไม่มี key ภายในหลุดออกมา
    for (const it of t.items) {
      if (it.voided) {
        expect(Object.keys(it).sort()).toEqual(["reason", "voided"]);
      } else {
        expect(Object.keys(it).sort()).toEqual(["stage", "voided"]);
      }
    }
  });

  it("stage label ภาษาไทยครบทุก stage ที่กำหนด (received→preparing→ready→served+closed)", () => {
    expect(CUSTOMER_STAGES).toEqual(["received", "preparing", "ready", "served", "closed"]);
    expect(CUSTOMER_STAGE_LABEL).toMatchObject({
      received: "ได้รับออเดอร์แล้ว",
      preparing: "กำลังเตรียม",
      ready: "พร้อมเสิร์ฟ",
      served: "เสิร์ฟแล้ว",
      closed: "เสร็จสิ้น",
    });
  });
});

describe("U12 stale-cancel messaging helpers", () => {
  it("isCancelRejectionMessage จำแนนเฉพาะข้อความปฏิเสธของ legacy cancel RPC", () => {
    expect(isCancelRejectionMessage("ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้")).toBe(true);
    expect(isCancelRejectionMessage("ออเดอร์นี้ยกเลิกไม่ได้")).toBe(true);
    expect(isCancelRejectionMessage("ออเดอร์ชำระเงินแล้ว ยกเลิกไม่ได้")).toBe(true);
    // ข้อความอื่น (ไม่พบออเดอร์/ไม่ใช่ QR/network) ต้องไม่เข้าเงื่อนไข
    expect(isCancelRejectionMessage("ไม่พบออเดอร์")).toBe(false);
    expect(isCancelRejectionMessage("ยกเลิกได้เฉพาะออเดอร์ที่สั่งผ่าน QR")).toBe(false);
    expect(isCancelRejectionMessage("network error")).toBe(false);
    expect(isCancelRejectionMessage("")).toBe(false);
  });

  it("composeStaleCancelMessage ระบุสถานะปัจจุบันในข้อความไทย", () => {
    expect(composeStaleCancelMessage("ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้", CUSTOMER_STAGE_LABEL.preparing)).toBe(
      "ครัวรับออเดอร์แล้ว ยกเลิกไม่ได้ (สถานะปัจจุบัน: กำลังเตรียม)",
    );
  });
});
