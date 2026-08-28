import { describe, expect, it } from "vitest";
import { getStoreReadiness } from "@/modules/onboarding/readiness";

const snap = (over: Partial<Parameters<typeof getStoreReadiness>[0]> = {}) => ({
  profileComplete: true,
  products: 0,
  tables: 0,
  printers: 0,
  members: 0,
  paidOrders: 0,
  ...over,
});

describe("onboarding readiness engine", () => {
  it("new store starts at store-profile with every step pending", () => {
    const r = getStoreReadiness(snap({ profileComplete: false }), { usesTables: true, needsPrinting: true });
    expect(r.completed).toBe(0);
    expect(r.nextStep).toBe("store-profile");
    expect(r.steps.map((s) => s.id)).toEqual([
      "store-profile",
      "catalog",
      "table",
      "printer",
      "first-paid-order",
    ]);
    expect(r.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("skips table/printer steps when profile says they are not used", () => {
    const r = getStoreReadiness(snap(), { usesTables: false, needsPrinting: false });
    expect(r.steps.map((s) => s.id)).toEqual(["store-profile", "catalog", "first-paid-order"]);
  });

  it("success requires a real paid order, not just products (plan contract)", () => {
    const r = getStoreReadiness(
      snap({ profileComplete: true, products: 1, tables: 0, printers: 0, members: 0, paidOrders: 0 }),
      { usesTables: false, needsPrinting: false },
    );
    expect(r.nextStep).toBe("first-paid-order");
  });

  it("walks table then printer then first paid order in order", () => {
    const withCatalog = getStoreReadiness(snap({ products: 5 }), { usesTables: true, needsPrinting: true });
    expect(withCatalog.nextStep).toBe("table");
    const withTables = getStoreReadiness(snap({ products: 5, tables: 4 }), { usesTables: true, needsPrinting: true });
    expect(withTables.nextStep).toBe("printer");
    const withPrinters = getStoreReadiness(snap({ products: 5, tables: 4, printers: 1 }), { usesTables: true, needsPrinting: true });
    expect(withPrinters.nextStep).toBe("first-paid-order");
  });

  it("ready store has no next step and counts every step complete", () => {
    const full = getStoreReadiness(
      snap({ products: 2, tables: 3, printers: 1, paidOrders: 7, members: 9 }),
      { usesTables: true, needsPrinting: true },
    );
    expect(full.completed).toBe(5);
    expect(full.nextStep).toBe(null);
    const lean = getStoreReadiness(snap({ products: 2, paidOrders: 1 }), { usesTables: false, needsPrinting: false });
    expect(lean.completed).toBe(3);
    expect(lean.nextStep).toBe(null);
  });

  it("members are informational only and never become a step", () => {
    const r = getStoreReadiness(snap({ members: 50 }), { usesTables: false, needsPrinting: false });
    expect(r.steps.map((s) => s.id)).not.toContain("members");
    expect(r.nextStep).toBe("catalog");
  });

  it("incomplete store profile blocks even when the store already sells", () => {
    const r = getStoreReadiness(snap({ profileComplete: false, products: 9, paidOrders: 9 }), {
      usesTables: true,
      needsPrinting: true,
    });
    expect(r.nextStep).toBe("store-profile");
    expect(r.completed).toBe(2);
  });

  it("is pure: same input returns an equal result", () => {
    const a = getStoreReadiness(snap({ products: 1, paidOrders: 1 }), { usesTables: false, needsPrinting: false });
    const b = getStoreReadiness(snap({ products: 1, paidOrders: 1 }), { usesTables: false, needsPrinting: false });
    expect(a).toEqual(b);
  });
});