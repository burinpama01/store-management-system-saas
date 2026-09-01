/**
 * Task U1 โ€” unified POS compatibility contracts (TDD, table-driven)
 *
 * เนเธเธเธญเนเธฒเธเธญเธดเธ: Plan/QR Order Voice Unified POS Implementation Plan v2.html
 *   - Section "Contracts เธ—เธตเนเธซเนเธฒเธกเน€เธเธฅเธตเนเธขเธเธเธงเธฒเธกเธซเธกเธฒเธข" โ’ Canonical void / Order prep derive
 *   - Task "U1 ยท Compatibility contracts เนเธฅเธฐ state map"
 *
 * เธเนเธญเน€เธ—เนเธเธเธฃเธดเธ DB เธ“ commit 16af52b (v0.35.0):
 *   - orders.status CHECK: draft | open | pending_payment | paid | refunded | voided | cancelled
 *   - orders.prep_status CHECK: new | preparing | served | done (เธขเธฑเธเนเธกเนเธกเธต 'ready')
 *   - order_items เธขเธฑเธเนเธกเนเธกเธต fulfillment_status (U2 เธเธฐเน€เธเธดเนเธก) เนเธ•เนเธกเธต voided boolean + voided_reason เธญเธขเธนเนเนเธฅเนเธง
 *     โ’ voided boolean เธเธทเธญ canonical, เธซเนเธฒเธกเธชเธฃเนเธฒเธ fulfillment_status='voided'
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

/** เธเธขเธฒเธขเธฒเธก mutate property เธเธญเธ object เธ—เธตเนเธเธงเธฃเธ–เธนเธ freeze โ€” strict mode เธเธฐ throw, เนเธกเนเธเธฑเนเธเน€เธเนเธ no-op */
function attemptMutate(target: object, key: string, value: unknown): "threw" | "noop" {
  try {
    (target as Record<string, unknown>)[key] = value;
    return "noop";
  } catch {
    return "threw";
  }
}

/** order_item stub เธชเธณเธซเธฃเธฑเธ test (voided default = false) */
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

describe("FULFILLMENT_STATUSES enum (เนเธเธ: Canonical void โ€” fulfillment_status: new|preparing|ready|served)", () => {
  it("เน€เธฃเธตเธขเธเธ•เธฃเธ target enum ['new','preparing','ready','served']", () => {
    expect([...FULFILLMENT_STATUSES]).toEqual(["new", "preparing", "ready", "served"]);
  });

  it("เธซเนเธฒเธกเธกเธต 'voided' เนเธ enum (assert เน€เธเธดเธเธ•เธฑเธงเธญเธฑเธเธฉเธฃ โ€” เธเธฑเธ dual truth เธเธฑเธ voided boolean)", () => {
    expect(FULFILLMENT_STATUSES).not.toContain("voided");
    expect(JSON.stringify(FULFILLMENT_STATUSES)).not.toContain("voided");
  });

  it("freeze เนเธฅเนเธง + mutate เนเธฅเนเธงเธเนเธฒเนเธกเนเน€เธเธฅเธตเนเธขเธ", () => {
    expect(Object.isFrozen(FULFILLMENT_STATUSES)).toBe(true);
    attemptMutate(FULFILLMENT_STATUSES, "0", "voided");
    attemptMutate(FULFILLMENT_STATUSES, "push", () => "voided");
    expect([...FULFILLMENT_STATUSES]).toEqual(["new", "preparing", "ready", "served"]);
  });
});

describe("ORDER_PREP_STATUSES enum (target prep_status: เน€เธ”เธดเธก new|preparing|served|done + เน€เธเธดเนเธก 'ready')", () => {
  it("เน€เธฃเธตเธขเธเธ•เธฃเธ target enum ['new','preparing','ready','served','done']", () => {
    expect([...ORDER_PREP_STATUSES]).toEqual(["new", "preparing", "ready", "served", "done"]);
  });

  it("เธ•เนเธญเธเธฃเธงเธก 'ready' (U2/U5 เธเธฐ extend CHECK) เนเธฅเธฐเธซเนเธฒเธกเธ—เธดเนเธ 'done'", () => {
    expect(ORDER_PREP_STATUSES).toContain("ready");
    expect(ORDER_PREP_STATUSES).toContain("done");
  });

  it("freeze เนเธฅเนเธง + mutate เนเธฅเนเธงเธเนเธฒเนเธกเนเน€เธเธฅเธตเนเธขเธ", () => {
    expect(Object.isFrozen(ORDER_PREP_STATUSES)).toBe(true);
    attemptMutate(ORDER_PREP_STATUSES, "0", "cancelled");
    expect([...ORDER_PREP_STATUSES]).toEqual(["new", "preparing", "ready", "served", "done"]);
  });
});

describe("effectiveItemState (เนเธเธ: Canonical void โ€” voided boolean เธเธเธฐ fulfillment status เน€เธชเธกเธญ)", () => {
  const matrix = [
    ...FULFILLMENT_STATUSES.map((status) => ({ status, voided: false, expected: status })),
    ...FULFILLMENT_STATUSES.map((status) => ({ status, voided: true, expected: "voided" as const })),
  ];

  it.each(matrix)("fulfillmentStatus=$status + voided=$voided โ’ $expected", ({ status, voided, expected }) => {
    expect(effectiveItemState({ voided, fulfillmentStatus: status })).toBe(expected);
  });
});

describe("deriveOrderPrepStatus (เนเธเธ: Order prep derive)", () => {
  const allNew: DeriveInput["items"] = [item("new"), item("new")];
  const paidAt = "2026-08-31T10:00:00.000Z";

  const deriveCases: Array<{ name: string; input: DeriveInput; expected: OrderPrepStatus }> = [
    // order เธเธดเธ”เนเธฅเนเธง (terminal status) โ’ done
    { name: "status cancelled โ’ done", input: { orderStatus: "cancelled", paidAt: null, items: allNew }, expected: "done" },
    { name: "status voided โ’ done", input: { orderStatus: "voided", paidAt: null, items: allNew }, expected: "done" },
    { name: "status refunded โ’ done", input: { orderStatus: "refunded", paidAt: null, items: allNew }, expected: "done" },
    { name: "status paid โ’ done", input: { orderStatus: "paid", paidAt: null, items: allNew }, expected: "done" },
    // paidAt เนเธกเน null โ’ done เนเธกเน status เธขเธฑเธ open
    { name: "open เนเธ•เน paidAt เนเธกเน null โ’ done", input: { orderStatus: "open", paidAt, items: allNew }, expected: "done" },
    // เนเธกเนเธกเธต active item โ’ done
    { name: "items เธงเนเธฒเธ โ’ done", input: { orderStatus: "open", paidAt: null, items: [] }, expected: "done" },
    { name: "เธ—เธธเธ item voided โ’ done", input: { orderStatus: "open", paidAt: null, items: [item("new", true), item("preparing", true), item("ready", true), item("served", true)] }, expected: "done" },
    // active เธ—เธฑเนเธเธซเธกเธ” new โ’ new (เธขเธฑเธเนเธกเนเธเธดเธ” order)
    { name: "open + paidAt null + active เธ—เธฑเนเธเธซเธกเธ” new โ’ new", input: { orderStatus: "open", paidAt: null, items: allNew }, expected: "new" },
    { name: "draft + paidAt เนเธกเนเธฃเธฐเธเธธ (undefined) + active เธ—เธฑเนเธเธซเธกเธ” new โ’ new", input: { orderStatus: "draft", items: allNew }, expected: "new" },
    { name: "pending_payment + active เธ—เธฑเนเธเธซเธกเธ” new โ’ new", input: { orderStatus: "pending_payment", paidAt: null, items: allNew }, expected: "new" },
    { name: "เธเธชเธก active + voided (active เน€เธซเธฅเธทเธญ new เธฅเนเธงเธ) โ’ new", input: { orderStatus: "open", paidAt: null, items: [item("new"), item("preparing", true)] }, expected: "new" },
    // เธเธชเธกเธซเธฅเธฒเธขเธชเธ–เธฒเธเธฐ โ’ preparing
    { name: "active เธ—เธฑเนเธเธซเธกเธ” preparing โ’ preparing", input: { orderStatus: "open", paidAt: null, items: [item("preparing"), item("preparing")] }, expected: "preparing" },
    { name: "เธเธชเธก new + preparing โ’ preparing", input: { orderStatus: "open", paidAt: null, items: [item("new"), item("preparing")] }, expected: "preparing" },
    { name: "เธเธชเธก new + ready โ’ preparing", input: { orderStatus: "open", paidAt: null, items: [item("new"), item("ready")] }, expected: "preparing" },
    { name: "เธเธชเธก new + preparing + ready + served โ’ preparing", input: { orderStatus: "open", paidAt: null, items: [item("new"), item("preparing"), item("ready"), item("served")] }, expected: "preparing" },
    // ready/served เธฅเนเธงเธ + เธกเธตเธญเธขเนเธฒเธเธเนเธญเธข 1 ready โ’ ready
    { name: "active เธ—เธฑเนเธเธซเธกเธ” ready โ’ ready", input: { orderStatus: "open", paidAt: null, items: [item("ready"), item("ready")] }, expected: "ready" },
    { name: "เธเธชเธก ready + served โ’ ready", input: { orderStatus: "open", paidAt: null, items: [item("ready"), item("served")] }, expected: "ready" },
    // served เธฅเนเธงเธ โ’ served
    { name: "active เธ—เธฑเนเธเธซเธกเธ” served โ’ served", input: { orderStatus: "open", paidAt: null, items: [item("served"), item("served")] }, expected: "served" },
    { name: "open + paidAt undefined + ready/served โ’ ready", input: { orderStatus: "open", items: [item("ready"), item("served")] }, expected: "ready" },
    // voided เนเธกเนเธกเธตเธเธฅเธ•เนเธญเธเธฅเธธเนเธก ready/served เธฅเนเธงเธ
    { name: "ready/served เธฅเนเธงเธ + item voided เธเธ โ’ ready", input: { orderStatus: "open", paidAt: null, items: [item("ready"), item("served"), item("new", true)] }, expected: "ready" },
  ];

  it.each(deriveCases)("$name", ({ input, expected }) => {
    expect(deriveOrderPrepStatus(input)).toBe(expected);
  });
});

describe("canTransitionItemFulfillment (เน€เธ”เธดเธเธซเธเนเธฒเธ—เธตเธฅเธฐเธเธฑเนเธ: newโ’preparingโ’readyโ’served)", () => {
  const forwardPairs: Array<[FulfillmentStatus, FulfillmentStatus]> = [
    ["new", "preparing"],
    ["preparing", "ready"],
    ["ready", "served"],
  ];

  it.each(forwardPairs)("เธเธฑเนเธเธ–เธฑเธ”เนเธ %s โ’ %s เธ•เนเธญเธ true", (from, to) => {
    expect(canTransitionItemFulfillment(from, to)).toBe(true);
  });

  const invalidPairs: Array<[FulfillmentStatus, FulfillmentStatus]> = [
    // เธ–เธญเธขเธซเธฅเธฑเธ (เธซเนเธฒเธก)
    ["preparing", "new"],
    ["ready", "preparing"],
    ["ready", "new"],
    ["served", "ready"],
    ["served", "preparing"],
    ["served", "new"],
    // เธเนเธฒเธกเธเธฑเนเธ (เธซเนเธฒเธก)
    ["new", "ready"],
    ["new", "served"],
    ["preparing", "served"],
    // เธชเธ–เธฒเธเธฐเน€เธ”เธตเธขเธงเธเธฑเธ (เธซเนเธฒเธก)
    ["new", "new"],
    ["preparing", "preparing"],
    ["ready", "ready"],
    ["served", "served"],
  ];

  it.each(invalidPairs)("เนเธกเนเนเธเนเธเธฑเนเธเธ–เธฑเธ”เนเธ %s โ’ %s เธ•เนเธญเธ false", (from, to) => {
    expect(canTransitionItemFulfillment(from, to)).toBe(false);
  });
});

describe("canCustomerCancelOrder (เธเธเน€เธ”เธดเธก QR: status open + unpaid + เธเนเธญเธเธเธฃเธฑเธงเธฃเธฑเธเธเธฒเธ)", () => {
  const allNew: CancelInput["items"] = [item("new"), item("new")];
  const paidAt = "2026-08-31T10:00:00.000Z";

  const cancelCases: Array<{ name: string; input: CancelInput; expected: boolean }> = [
    // เธเนเธฒเธ
    { name: "open + unpaid + active เธ—เธฑเนเธเธซเธกเธ” new โ’ true", input: { status: "open", paidAt: null, items: allNew }, expected: true },
    { name: "open + unpaid + active new เธเธดเนเธเน€เธ”เธตเธขเธง โ’ true", input: { status: "open", paidAt: null, items: [item("new")] }, expected: true },
    { name: "open + paidAt undefined (optional) + active เธ—เธฑเนเธเธซเธกเธ” new โ’ true", input: { status: "open", items: allNew }, expected: true },
    { name: "active new + item voided เธ—เธตเนเน€เธเธข preparing เธเธ โ’ true (canonical void เนเธกเน block cancel)", input: { status: "open", paidAt: null, items: [item("new"), item("preparing", true)] }, expected: true },
    // เนเธกเนเธเนเธฒเธ: active item เน€เธฅเธขเธเธฑเนเธ new
    { name: "เธกเธต active preparing โ’ false", input: { status: "open", paidAt: null, items: [item("new"), item("preparing")] }, expected: false },
    { name: "เธกเธต active ready โ’ false", input: { status: "open", paidAt: null, items: [item("ready")] }, expected: false },
    { name: "เธกเธต active served โ’ false", input: { status: "open", paidAt: null, items: [item("served")] }, expected: false },
    // เนเธกเนเธเนเธฒเธ: เธเนเธฒเธขเนเธฅเนเธง / status เธญเธทเนเธ
    { name: "open เนเธ•เน paidAt เนเธกเน null (เธเนเธฒเธขเนเธฅเนเธง) โ’ false", input: { status: "open", paidAt, items: allNew }, expected: false },
    { name: "status paid โ’ false", input: { status: "paid", paidAt: null, items: allNew }, expected: false },
    { name: "status pending_payment โ’ false", input: { status: "pending_payment", paidAt: null, items: allNew }, expected: false },
    { name: "status draft โ’ false", input: { status: "draft", paidAt: null, items: allNew }, expected: false },
    { name: "status cancelled โ’ false", input: { status: "cancelled", paidAt: null, items: allNew }, expected: false },
    { name: "status refunded โ’ false", input: { status: "refunded", paidAt: null, items: allNew }, expected: false },
    { name: "status voided โ’ false", input: { status: "voided", paidAt: null, items: allNew }, expected: false },
    // เนเธกเนเธเนเธฒเธ: เนเธกเนเธกเธต active item
    { name: "items เธงเนเธฒเธ โ’ false", input: { status: "open", paidAt: null, items: [] }, expected: false },
    { name: "เธ—เธธเธ item voided โ’ false", input: { status: "open", paidAt: null, items: [item("new", true), item("preparing", true)] }, expected: false },
  ];

  it.each(cancelCases)("$name", ({ input, expected }) => {
    expect(canCustomerCancelOrder(input)).toBe(expected);
  });
});

describe("UNIFIED_POS_ERROR_CODES (stable error codes prefix 'up_' เธชเธณเธซเธฃเธฑเธ RPC U5-U7)", () => {
  it("เธเธฃเธเธ—เธธเธ key เธ•เธฒเธกเนเธเธ", () => {
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

  it("เธ—เธธเธเธเนเธฒเน€เธเนเธ string เธเธถเนเธเธ•เนเธเธ”เนเธงเธข 'up_'", () => {
    for (const value of Object.values(UNIFIED_POS_ERROR_CODES)) {
      expect(value).toMatch(/^up_[a-z_]+$/);
    }
    expect(UNIFIED_POS_ERROR_CODES.stale_version).toBe("up_stale_version");
    // U4 (v0.35.4): เน€เธเธดเนเธกเธชเธณเธซเธฃเธฑเธ auto-open failure (session เธซเธกเธ”เธญเธฒเธขเธธ + เธเธเธซเนเธฒเธกเน€เธเธดเธ”เน€เธญเธ)
    expect(UNIFIED_POS_ERROR_CODES.session_not_active).toBe("up_session_not_active");
  });

  it("Object.freeze เนเธฅเนเธง + เธเธขเธฒเธขเธฒเธก mutate เนเธฅเนเธงเธเนเธฒเนเธกเนเน€เธเธฅเธตเนเธขเธ", () => {
    expect(Object.isFrozen(UNIFIED_POS_ERROR_CODES)).toBe(true);
    const before = { ...UNIFIED_POS_ERROR_CODES };
    attemptMutate(UNIFIED_POS_ERROR_CODES, "stale_version", "up_hacked");
    attemptMutate(UNIFIED_POS_ERROR_CODES, "injected_key", "up_injected");
    expect({ ...UNIFIED_POS_ERROR_CODES }).toEqual(before);
    expect(Object.keys(UNIFIED_POS_ERROR_CODES)).not.toContain("injected_key");
  });
});

describe("type-level guard (compile-time โ€” เธเธฑเธ dual truth เธฃเธญเธเธชเธญเธ)", () => {
  it("'done' (OrderPrepStatus) เนเธฅเธฐ 'voided' เธ•เนเธญเธเนเธกเนเนเธเน FulfillmentStatus", () => {
    const acceptFulfillment = (_status: FulfillmentStatus): undefined => undefined;

    // @ts-expect-error 'done' เธญเธขเธนเนเนเธ OrderPrepStatus เนเธ•เนเธซเนเธฒเธกเธญเธขเธนเนเนเธ FulfillmentStatus
    expect(acceptFulfillment("done" as OrderPrepStatus)).toBeUndefined();
    // @ts-expect-error 'voided' เธซเนเธฒเธกเธญเธขเธนเนเนเธ FulfillmentStatus (voided boolean เธเธทเธญ canonical)
    expect(acceptFulfillment("voided")).toBeUndefined();
  });
});

describe("operation envelope/result (เนเธเธ: Idempotency retention โ€” เนเธเนเธ•เนเธญเนเธ U4-U7)", () => {
  it("UnifiedPosOperationRequest เธกเธต operationKey + requestHash เน€เธ—เนเธฒเธเธฑเนเธ", () => {
    const request: UnifiedPosOperationRequest = { operationKey: "op_1", requestHash: "sha256:abc123" };
    expect(Object.keys(request).sort()).toEqual(["operationKey", "requestHash"].sort());
  });

  it("UnifiedPosOperationOutcome เนเธเน discriminant 'status' เนเธขเธ executed/replayed/hash_conflict เนเธ”เน", () => {
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
