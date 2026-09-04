import { describe, expect, it } from "vitest";
import {
  aggregatePoolDemand,
  nextStockQuantity,
} from "@/modules/stock/pool-math";

describe("aggregatePoolDemand", () => {
  it("aggregates demand from different products and variants that share a pool", () => {
    const demand = aggregatePoolDemand([
      { poolId: "singha", orderQuantity: 2, unitsPerItem: 1 },
      { poolId: "singha", orderQuantity: 1, unitsPerItem: 3 },
    ]);

    expect(demand).toEqual(new Map([["singha", 5]]));
  });

  it("keeps separate pools separate", () => {
    const demand = aggregatePoolDemand([
      { poolId: "singha", orderQuantity: 2, unitsPerItem: 1 },
      { poolId: "leo", orderQuantity: 3, unitsPerItem: 2 },
    ]);

    expect(demand).toEqual(
      new Map([
        ["singha", 2],
        ["leo", 6],
      ]),
    );
  });

  it.each([
    [[{ poolId: "", orderQuantity: 1, unitsPerItem: 1 }]],
    [[{ poolId: "   ", orderQuantity: 1, unitsPerItem: 1 }]],
    [[{ poolId: "singha", orderQuantity: 1.5, unitsPerItem: 1 }]],
    [[{ poolId: "singha", orderQuantity: 0, unitsPerItem: 1 }]],
    [[{ poolId: "singha", orderQuantity: -1, unitsPerItem: 1 }]],
    [[{ poolId: "singha", orderQuantity: Number.POSITIVE_INFINITY, unitsPerItem: 1 }]],
    [[{ poolId: "singha", orderQuantity: 1, unitsPerItem: 1.5 }]],
    [[{ poolId: "singha", orderQuantity: 1, unitsPerItem: 0 }]],
    [[{ poolId: "singha", orderQuantity: 1, unitsPerItem: -1 }]],
    [[{ poolId: "singha", orderQuantity: 1, unitsPerItem: Number.NaN }]],
  ])("rejects invalid pool demand input: %o", (items) => {
    expect(() => aggregatePoolDemand(items)).toThrow(/ต้อง/);
  });

  it("rejects unsafe integer demand and accumulated demand", () => {
    expect(() =>
      aggregatePoolDemand([
        { poolId: "singha", orderQuantity: Number.MAX_SAFE_INTEGER, unitsPerItem: 2 },
      ]),
    ).toThrow(/ต้อง/);
    expect(() =>
      aggregatePoolDemand([
        { poolId: "singha", orderQuantity: Number.MAX_SAFE_INTEGER, unitsPerItem: 1 },
        { poolId: "singha", orderQuantity: 1, unitsPerItem: 1 },
      ]),
    ).toThrow(/ต้อง/);
  });

  it("rejects pool IDs with leading or trailing whitespace without mutating inputs", () => {
    const items = [{ poolId: " singha ", orderQuantity: 1, unitsPerItem: 1 }];
    const before = structuredClone(items);

    expect(() => aggregatePoolDemand(items)).toThrow(/รหัส Stock Pool/);

    expect(items).toEqual(before);
  });

  it("does not mutate demand inputs", () => {
    const items = [
      { poolId: "singha", orderQuantity: 2, unitsPerItem: 1 },
      { poolId: "singha", orderQuantity: 1, unitsPerItem: 3 },
    ];
    const before = structuredClone(items);

    aggregatePoolDemand(items);

    expect(items).toEqual(before);
  });
});

describe("nextStockQuantity", () => {
  it("adds a receive quantity to the current stock", () => {
    expect(nextStockQuantity(30, { mode: "receive", quantity: 12 })).toBe(42);
  });

  it("replaces the current stock for set_balance", () => {
    expect(
      nextStockQuantity(30, {
        mode: "set_balance",
        quantity: 27,
        reason: "ตรวจนับสต็อก",
      }),
    ).toBe(27);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid receive quantity: %o",
    (quantity) => {
      expect(() => nextStockQuantity(30, { mode: "receive", quantity })).toThrow(/ต้อง/);
    },
  );

  it("allows zero for set_balance only when a nonblank reason is supplied", () => {
    expect(
      nextStockQuantity(30, {
        mode: "set_balance",
        quantity: 0,
        reason: "สินค้าสูญหาย",
      }),
    ).toBe(0);
    expect(() =>
      nextStockQuantity(30, { mode: "set_balance", quantity: 0, reason: "" }),
    ).toThrow(/เหตุผล/);
    expect(() =>
      nextStockQuantity(30, { mode: "set_balance", quantity: 0, reason: "   " }),
    ).toThrow(/เหตุผล/);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid set_balance quantity: %o",
    (quantity) => {
      expect(() =>
        nextStockQuantity(30, {
          mode: "set_balance",
          quantity,
          reason: "ตรวจนับสต็อก",
        }),
      ).toThrow(/ต้อง/);
    },
  );

  it.each(["", "   "])(
    "rejects a blank set_balance reason for a positive quantity: %o",
    (reason) => {
      expect(() =>
        nextStockQuantity(30, { mode: "set_balance", quantity: 27, reason }),
      ).toThrow(/เหตุผล/);
    },
  );

  it("rejects an unknown adjustment mode with a domain error", () => {
    const input = {
      mode: "unknown",
      quantity: 12,
      reason: "ไม่ควรถูกใช้",
    } as unknown as Parameters<typeof nextStockQuantity>[1];

    expect(() => nextStockQuantity(30, input)).toThrow(/โหมด/);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid current stock: %o",
    (current) => {
      expect(() =>
        nextStockQuantity(current, { mode: "receive", quantity: 1 }),
      ).toThrow(/จำนวนสต็อก/);
    },
  );

  it("rejects receive results outside the safe integer range", () => {
    expect(() =>
      nextStockQuantity(Number.MAX_SAFE_INTEGER, { mode: "receive", quantity: 1 }),
    ).toThrow(/ต้อง/);
  });

  it("does not mutate adjustment inputs", () => {
    const adjustment = { mode: "set_balance" as const, quantity: 27, reason: "ตรวจนับ" };
    const before = structuredClone(adjustment);

    nextStockQuantity(30, adjustment);

    expect(adjustment).toEqual(before);
  });
});
