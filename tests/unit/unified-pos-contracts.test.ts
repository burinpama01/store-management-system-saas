/**
 * Task U1 — unified POS compatibility contracts (TDD, table-driven)
 *
 * แผนอ้างอิง: Plan/QR Order Voice Unified POS Implementation Plan v2.html
 *   - Section "Contracts ที่ห้ามเปลี่ยนความหมาย" → Canonical void / Order prep derive
 *   - Task "U1 · Compatibility contracts และ state map"
 *
 * ข้อเท็จจริง DB ณ commit 16af52b (v0.35.0):
 *   - orders.status CHECK: draft | open | pending_payment | paid | refunded | voided | cancelled
 *   - orders.prep_status CHECK: new | preparing | served | done (ยังไม่มี 'ready')
 *   - order_items ยังไม่มี fulfillment_status (U2 จะเพิ่ม) แต่มี voided boolean + voided_reason อยู่แล้ว
 *     → voided boolean คือ canonical, ห้ามสร้าง fulfillment_status='voided'
 */

import { describe, it, expect } from "vitest";
import {
  FULFILLMENT_STATUSES,
  ORDER_PREP_STATUSES,
  UNIFIED_POS_ERROR_CODES,
  effectiveItemState,
  deriveOrderPrepStatus,
  canTransitionItemFulfillment,
  canCustomerCancelOrder,
  type FulfillmentStatus,
  type OrderPrepStatus,
  type OrderStatus,
  type ItemFulfillmentInput,
  type UnifiedPosOperationOutcome,
  type UnifiedPosOperationRequest,
} from "@/modules/unified-pos/contracts";

/** พยายาม mutate property ของ object ที่ควรถูก freeze — strict mode จะ throw, ไม่งั้นเป็น no-op */
function attemptMutate(target: object, key: string, value: unknown): "threw" | "noop" {
  try {
    (target as Record<string, unknown>)[key] = value;
    return "noop";
  } catch {
    return "threw";
  }
}

/** order_item stub สำหรับ test (voided default = false) */
const item = (fulfillmentStatus: FulfillmentStatus, voided = false) => ({ voided, fulfillmentStatus });

type DeriveInput = {
  orderStatus: OrderStatus;
  paidAt?: string | null;
  items: ItemFulfillmentInput[];
};

type CancelInput = {
  status: OrderStatus;
  paidAt?: string | null;
  items: ItemFulfillmentInput[];
};

describe("FULFILLMENT_STATUSES enum (แผน: Canonical void — fulfillment_status: new|preparing|ready|served)", () => {
  it("เรียงตรง target enum ['new','preparing','ready','served']", () => {
    expect([...FULFILLMENT_STATUSES]).toEqual(["new", "preparing", "ready", "served"]);
  });

  it("ห้ามมี 'voided' ใน enum (assert เชิงตัวอักษร — กัน dual truth กับ voided boolean)", () => {
    expect(FULFILLMENT_STATUSES).not.toContain("voided");
    expect(JSON.stringify(FULFILLMENT_STATUSES)).not.toContain("voided");
  });

  it("freeze แล้ว + mutate แล้วค่าไม่เปลี่ยน", () => {
    expect(Object.isFrozen(FULFILLMENT_STATUSES)).toBe(true);
    attemptMutate(FULFILLMENT_STATUSES, "0", "voided");
    attemptMutate(FULFILLMENT_STATUSES, "push", () => "voided");
    expect([...FULFILLMENT_STATUSES]).toEqual(["new", "preparing", "ready", "served"]);
  });
});

describe("ORDER_PREP_STATUSES enum (target prep_status: เดิม new|preparing|served|done + เพิ่ม 'ready')", () => {
  it("เรียงตรง target enum ['new','preparing','ready','served','done']", () => {
    expect([...ORDER_PREP_STATUSES]).toEqual(["new", "preparing", "ready", "served", "done"]);
  });

  it("ต้องรวม 'ready' (U2/U5 จะ extend CHECK) และห้ามทิ้ง 'done'", () => {
    expect(ORDER_PREP_STATUSES).toContain("ready");
    expect(ORDER_PREP_STATUSES).toContain("done");
  });

  it("freeze แล้ว + mutate แล้วค่าไม่เปลี่ยน", () => {
    expect(Object.isFrozen(ORDER_PREP_STATUSES)).toBe(true);
    attemptMutate(ORDER_PREP_STATUSES, "0", "cancelled");
    expect([...ORDER_PREP_STATUSES]).toEqual(["new", "preparing", "ready", "served", "done"]);
  });
});

describe("effectiveItemState (แผน: Canonical void — voided boolean ชนะ fulfillment status เสมอ)", () => {
  const matrix = [
    ...FULFILLMENT_STATUSES.map((status) => ({ status, voided: false, expected: status })),
    ...FULFILLMENT_STATUSES.map((status) => ({ status, voided: true, expected: "voided" as const })),
  ];

  it.each(matrix)("fulfillmentStatus=$status + voided=$voided → $expected", ({ status, voided, expected }) => {
    expect(effectiveItemState({ voided, fulfillmentStatus: status })).toBe(expected);
  });
});

describe("deriveOrderPrepStatus (แผน: Order prep derive)", () => {
  const allNew: DeriveInput["items"] = [item("new"), item("new")];
  const paidAt = "2026-08-31T10:00:00.000Z";

  const deriveCases: Array<{ name: string; input: DeriveInput; expected: OrderPrepStatus }> = [
    // order ปิดแล้ว (terminal status) → done
    { name: "status cancelled → done", input: { orderStatus: "cancelled", paidAt: null, items: allNew }, expected: "done" },
    { name: "status voided → done", input: { orderStatus: "voided", paidAt: null, items: allNew }, expected: "done" },
    { name: "status refunded → done", input: { orderStatus: "refunded", paidAt: null, items: allNew }, expected: "done" },
    { name: "status paid → done", input: { orderStatus: "paid", paidAt: null, items: allNew }, expected: "done" },
    // paidAt ไม่ null → done แม้ status ยัง open
    { name: "open แต่ paidAt ไม่ null → done", input: { orderStatus: "open", paidAt, items: allNew }, expected: "done" },
    // ไม่มี active item → done
    { name: "items ว่าง → done", input: { orderStatus: "open", paidAt: null, items: [] }, expected: "done" },
    { name: "ทุก item voided → done", input: { orderStatus: "open", paidAt: null, items: [item("new", true), item("preparing", true), item("ready", true), item("served", true)] }, expected: "done" },
    // active ทั้งหมด new → new (ยังไม่ปิด order)
    { name: "open + paidAt null + active ทั้งหมด new → new", input: { orderStatus: "open", paidAt: null, items: allNew }, expected: "new" },
    { name: "draft + paidAt ไม่ระบุ (undefined) + active ทั้งหมด new → new", input: { orderStatus: "draft", items: allNew }, expected: "new" },
    { name: "pending_payment + active ทั้งหมด new → new", input: { orderStatus: "pending_payment", paidAt: null, items: allNew }, expected: "new" },
    { name: "ผสม active + voided (active เหลือ new ล้วน) → new", input: { orderStatus: "open", paidAt: null, items: [item("new"), item("preparing", true)] }, expected: "new" },
    // ผสมหลายสถานะ → preparing
    { name: "active ทั้งหมด preparing → preparing", input: { orderStatus: "open", paidAt: null, items: [item("preparing"), item("preparing")] }, expected: "preparing" },
    { name: "ผสม new + preparing → preparing", input: { orderStatus: "open", paidAt: null, items: [item("new"), item("preparing")] }, expected: "preparing" },
    { name: "ผสม new + ready → preparing", input: { orderStatus: "open", paidAt: null, items: [item("new"), item("ready")] }, expected: "preparing" },
    { name: "ผสม new + preparing + ready + served → preparing", input: { orderStatus: "open", paidAt: null, items: [item("new"), item("preparing"), item("ready"), item("served")] }, expected: "preparing" },
    // ready/served ล้วน + มีอย่างน้อย 1 ready → ready
    { name: "active ทั้งหมด ready → ready", input: { orderStatus: "open", paidAt: null, items: [item("ready"), item("ready")] }, expected: "ready" },
    { name: "ผสม ready + served → ready", input: { orderStatus: "open", paidAt: null, items: [item("ready"), item("served")] }, expected: "ready" },
    // served ล้วน → served
    { name: "active ทั้งหมด served → served", input: { orderStatus: "open", paidAt: null, items: [item("served"), item("served")] }, expected: "served" },
    { name: "open + paidAt undefined + ready/served → ready", input: { orderStatus: "open", items: [item("ready"), item("served")] }, expected: "ready" },
    // voided ไม่มีผลต่อกลุ่ม ready/served ล้วน
    { name: "ready/served ล้วน + item voided ปน → ready", input: { orderStatus: "open", paidAt: null, items: [item("ready"), item("served"), item("new", true)] }, expected: "ready" },
  ];

  it.each(deriveCases)("$name", ({ input, expected }) => {
    expect(deriveOrderPrepStatus(input)).toBe(expected);
  });
});

describe("canTransitionItemFulfillment (เดินหน้าทีละขั้น: new→preparing→ready→served)", () => {
  const forwardPairs: Array<[FulfillmentStatus, FulfillmentStatus]> = [
    ["new", "preparing"],
    ["preparing", "ready"],
    ["ready", "served"],
  ];

  it.each(forwardPairs)("ขั้นถัดไป %s → %s ต้อง true", (from, to) => {
    expect(canTransitionItemFulfillment(from, to)).toBe(true);
  });

  const invalidPairs: Array<[FulfillmentStatus, FulfillmentStatus]> = [
    // ถอยหลัง (ห้าม)
    ["preparing", "new"],
    ["ready", "preparing"],
    ["ready", "new"],
    ["served", "ready"],
    ["served", "preparing"],
    ["served", "new"],
    // ข้ามขั้น (ห้าม)
    ["new", "ready"],
    ["new", "served"],
    ["preparing", "served"],
    // สถานะเดียวกัน (ห้าม)
    ["new", "new"],
    ["preparing", "preparing"],
    ["ready", "ready"],
    ["served", "served"],
  ];

  it.each(invalidPairs)("ไม่ใช่ขั้นถัดไป %s → %s ต้อง false", (from, to) => {
    expect(canTransitionItemFulfillment(from, to)).toBe(false);
  });
});

describe("canCustomerCancelOrder (กฎเดิม QR: status open + unpaid + ก่อนครัวรับงาน)", () => {
  const allNew: CancelInput["items"] = [item("new"), item("new")];
  const paidAt = "2026-08-31T10:00:00.000Z";

  const cancelCases: Array<{ name: string; input: CancelInput; expected: boolean }> = [
    // ผ่าน
    { name: "open + unpaid + active ทั้งหมด new → true", input: { status: "open", paidAt: null, items: allNew }, expected: true },
    { name: "open + unpaid + active new ชิ้นเดียว → true", input: { status: "open", paidAt: null, items: [item("new")] }, expected: true },
    { name: "open + paidAt undefined (optional) + active ทั้งหมด new → true", input: { status: "open", items: allNew }, expected: true },
    { name: "active new + item voided ที่เคย preparing ปน → true (canonical void ไม่ block cancel)", input: { status: "open", paidAt: null, items: [item("new"), item("preparing", true)] }, expected: true },
    // ไม่ผ่าน: active item เลยขั้น new
    { name: "มี active preparing → false", input: { status: "open", paidAt: null, items: [item("new"), item("preparing")] }, expected: false },
    { name: "มี active ready → false", input: { status: "open", paidAt: null, items: [item("ready")] }, expected: false },
    { name: "มี active served → false", input: { status: "open", paidAt: null, items: [item("served")] }, expected: false },
    // ไม่ผ่าน: จ่ายแล้ว / status อื่น
    { name: "open แต่ paidAt ไม่ null (จ่ายแล้ว) → false", input: { status: "open", paidAt, items: allNew }, expected: false },
    { name: "status paid → false", input: { status: "paid", paidAt: null, items: allNew }, expected: false },
    { name: "status pending_payment → false", input: { status: "pending_payment", paidAt: null, items: allNew }, expected: false },
    { name: "status draft → false", input: { status: "draft", paidAt: null, items: allNew }, expected: false },
    { name: "status cancelled → false", input: { status: "cancelled", paidAt: null, items: allNew }, expected: false },
    { name: "status refunded → false", input: { status: "refunded", paidAt: null, items: allNew }, expected: false },
    { name: "status voided → false", input: { status: "voided", paidAt: null, items: allNew }, expected: false },
    // ไม่ผ่าน: ไม่มี active item
    { name: "items ว่าง → false", input: { status: "open", paidAt: null, items: [] }, expected: false },
    { name: "ทุก item voided → false", input: { status: "open", paidAt: null, items: [item("new", true), item("preparing", true)] }, expected: false },
  ];

  it.each(cancelCases)("$name", ({ input, expected }) => {
    expect(canCustomerCancelOrder(input)).toBe(expected);
  });
});

describe("UNIFIED_POS_ERROR_CODES (stable error codes prefix 'up_' สำหรับ RPC U5-U7)", () => {
  it("ครบทุก key ตามแผน", () => {
    expect(Object.keys(UNIFIED_POS_ERROR_CODES).sort()).toEqual(
      [
        "stale_version",
        "invalid_state_transition",
        "hash_conflict",
        "invalid_item",
        "not_found",
        "forbidden",
        "cancel_not_allowed",
        "stock_insufficient",
        "store_flag_disabled",
        "session_not_active",
        "invalid_payment",
      ].sort()
    );
  });

  it("ทุกค่าเป็น string ขึ้นต้นด้วย 'up_'", () => {
    for (const value of Object.values(UNIFIED_POS_ERROR_CODES)) {
      expect(value).toMatch(/^up_[a-z_]+$/);
    }
    expect(UNIFIED_POS_ERROR_CODES.stale_version).toBe("up_stale_version");
    // U4 (v0.35.4): เพิ่มสำหรับ auto-open failure (session หมดอายุ + กฎห้ามเปิดเอง)
    expect(UNIFIED_POS_ERROR_CODES.session_not_active).toBe("up_session_not_active");
  });

  it("Object.freeze แล้ว + พยายาม mutate แล้วค่าไม่เปลี่ยน", () => {
    expect(Object.isFrozen(UNIFIED_POS_ERROR_CODES)).toBe(true);
    const before = { ...UNIFIED_POS_ERROR_CODES };
    attemptMutate(UNIFIED_POS_ERROR_CODES, "stale_version", "up_hacked");
    attemptMutate(UNIFIED_POS_ERROR_CODES, "injected_key", "up_injected");
    expect({ ...UNIFIED_POS_ERROR_CODES }).toEqual(before);
    expect(Object.keys(UNIFIED_POS_ERROR_CODES)).not.toContain("injected_key");
  });
});

describe("type-level guard (compile-time — กัน dual truth รอบสอง)", () => {
  it("'done' (OrderPrepStatus) และ 'voided' ต้องไม่ใช่ FulfillmentStatus", () => {
    const acceptFulfillment = (_status: FulfillmentStatus): undefined => undefined;

    // @ts-expect-error 'done' อยู่ใน OrderPrepStatus แต่ห้ามอยู่ใน FulfillmentStatus
    expect(acceptFulfillment("done" as OrderPrepStatus)).toBeUndefined();
    // @ts-expect-error 'voided' ห้ามอยู่ใน FulfillmentStatus (voided boolean คือ canonical)
    expect(acceptFulfillment("voided")).toBeUndefined();
  });
});

describe("operation envelope/result (แผน: Idempotency retention — ใช้ต่อใน U4-U7)", () => {
  it("UnifiedPosOperationRequest มี operationKey + requestHash เท่านั้น", () => {
    const request: UnifiedPosOperationRequest = { operationKey: "op_1", requestHash: "sha256:abc123" };
    expect(Object.keys(request).sort()).toEqual(["operationKey", "requestHash"].sort());
  });

  it("UnifiedPosOperationOutcome ใช้ discriminant 'status' แยก executed/replayed/hash_conflict ได้", () => {
    const summarize = (outcome: UnifiedPosOperationOutcome<number>): string => {
      switch (outcome.status) {
        case "executed":
          return `executed:${outcome.result}`;
        case "replayed":
          return `replayed:${outcome.result}`;
        case "hash_conflict":
          return "hash_conflict";
      }
    };

    expect(summarize({ status: "executed", result: 42 })).toBe("executed:42");
    expect(summarize({ status: "replayed", result: 42 })).toBe("replayed:42");
    expect(summarize({ status: "hash_conflict" })).toBe("hash_conflict");
  });
});
