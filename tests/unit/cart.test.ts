import { describe, it, expect } from "vitest";
import { buildCartItemKey } from "@/modules/pos/types";

describe("buildCartItemKey", () => {
  it("same product + variant + modifiers produces same key", () => {
    const key1 = buildCartItemKey({
      productId: "p1",
      variantId: "v1",
      modifierOptionIds: ["m1", "m2"],
    });
    const key2 = buildCartItemKey({
      productId: "p1",
      variantId: "v1",
      modifierOptionIds: ["m2", "m1"],
    });
    expect(key1).toBe(key2);
  });

  it("different variants produce different keys", () => {
    const key1 = buildCartItemKey({ productId: "p1", variantId: "v1", modifierOptionIds: [] });
    const key2 = buildCartItemKey({ productId: "p1", variantId: "v2", modifierOptionIds: [] });
    expect(key1).not.toBe(key2);
  });

  it("no variant produces a valid key", () => {
    const key = buildCartItemKey({ productId: "p1", variantId: null, modifierOptionIds: [] });
    expect(key).toContain("p1");
  });

  it("different modifier sets produce different keys", () => {
    const key1 = buildCartItemKey({ productId: "p1", variantId: null, modifierOptionIds: ["m1"] });
    const key2 = buildCartItemKey({ productId: "p1", variantId: null, modifierOptionIds: ["m2"] });
    expect(key1).not.toBe(key2);
  });

  it("different products produce different keys", () => {
    const key1 = buildCartItemKey({ productId: "p1", variantId: null, modifierOptionIds: [] });
    const key2 = buildCartItemKey({ productId: "p2", variantId: null, modifierOptionIds: [] });
    expect(key1).not.toBe(key2);
  });
});
