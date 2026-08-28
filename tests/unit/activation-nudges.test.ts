import { describe, expect, it } from "vitest";
import { bangkokDateIso, pickActivationNudge } from "@/modules/onboarding/nudges";

const ready = {
  profileComplete: true,
  products: 3,
  tables: 2,
  printers: 1,
  members: 0,
  paidOrders: 0,
};

describe("activation nudges — deterministic, once daily, stop on first paid order", () => {
  it("formats the idempotency date in Asia/Bangkok (UTC 17:30 = next day 00:30 BKK)", () => {
    expect(bangkokDateIso(new Date("2026-08-28T17:30:00Z"))).toBe("2026-08-29");
    expect(bangkokDateIso(new Date("2026-08-28T12:00:00Z"))).toBe("2026-08-28");
  });

  it("stops entirely once the store has a real paid order", () => {
    const r = pickActivationNudge({
      storeId: "s1",
      readiness: { ...ready, paidOrders: 2 },
      profile: { usesTables: true, needsPrinting: true },
      nudgedStepsToday: [],
      optedOut: false,
      now: new Date("2026-08-28T04:00:00Z"),
    });
    expect(r).toBeNull();
  });

  it("respects opt-out", () => {
    const r = pickActivationNudge({
      storeId: "s1",
      readiness: { profileComplete: false, products: 0, tables: 0, printers: 0, members: 0, paidOrders: 0 },
      profile: { usesTables: true, needsPrinting: true },
      nudgedStepsToday: [],
      optedOut: true,
      now: new Date("2026-08-28T04:00:00Z"),
    });
    expect(r).toBeNull();
  });

  it("nudges the readiness next step with the store+step+date idempotency key", () => {
    const r = pickActivationNudge({
      storeId: "s1",
      readiness: { profileComplete: false, products: 0, tables: 0, printers: 0, members: 0, paidOrders: 0 },
      profile: { usesTables: true, needsPrinting: true },
      nudgedStepsToday: [],
      optedOut: false,
      now: new Date("2026-08-28T04:00:00Z"),
    });
    expect(r?.step).toBe("store-profile");
    expect(r?.idempotencyKey).toBe("s1:store-profile:2026-08-28");
  });

  it("never sends the same step twice on the same Bangkok day", () => {
    const r = pickActivationNudge({
      storeId: "s1",
      readiness: { ...ready, profileComplete: true, products: 3 },
      profile: { usesTables: false, needsPrinting: false },
      nudgedStepsToday: ["first-paid-order"],
      optedOut: false,
      now: new Date("2026-08-28T04:00:00Z"),
    });
    expect(r).toBeNull();
  });

  it("skips steps that the setup profile says are not used (via readiness engine)", () => {
    const r = pickActivationNudge({
      storeId: "s1",
      readiness: { profileComplete: true, products: 0, tables: 0, printers: 0, members: 0, paidOrders: 0 },
      profile: { usesTables: false, needsPrinting: false },
      nudgedStepsToday: ["store-profile"],
      optedOut: false,
      now: new Date("2026-08-28T04:00:00Z"),
    });
    expect(r?.step).toBe("catalog");
  });

  it("returns null when the store is already fully ready", () => {
    const r = pickActivationNudge({
      storeId: "s1",
      readiness: { ...ready, paidOrders: 5 },
      profile: { usesTables: true, needsPrinting: true },
      nudgedStepsToday: [],
      optedOut: false,
      now: new Date("2026-08-28T04:00:00Z"),
    });
    expect(r).toBeNull();
  });
});