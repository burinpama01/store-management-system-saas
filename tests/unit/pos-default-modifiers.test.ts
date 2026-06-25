import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModifierGroup } from "@/modules/catalog/types";

const root = process.cwd();
const helperPath = join(root, "src/modules/pos/default-modifiers.ts");

function option(groupId: string, name: string, priceAdjustment = 0, isDefault = false) {
  return {
    id: `${groupId}-${name}`,
    modifierGroupId: groupId,
    name,
    priceAdjustment,
    isDefault,
    isActive: true,
    sortOrder: 1,
  };
}

function group(input: {
  id: string;
  name: string;
  options: ReturnType<typeof option>[];
  selectionType?: "single" | "multiple";
  maxSelections?: number;
  isRequired?: boolean;
  minSelections?: number;
}): ModifierGroup {
  return {
    id: input.id,
    productId: "p1",
    name: input.name,
    selectionType: input.selectionType ?? "single",
    isRequired: input.isRequired ?? true,
    minSelections: input.minSelections ?? 1,
    maxSelections: input.maxSelections ?? 1,
    sortOrder: 1,
    options: input.options,
  };
}

describe("buildDefaultModifierSelections", () => {
  it("auto-selects standard POS defaults for speed when product options are not explicitly marked default", async () => {
    expect(existsSync(helperPath)).toBe(true);
    const { buildDefaultModifierSelections } = await import("@/modules/pos/default-modifiers");

    const selections = buildDefaultModifierSelections([
      group({ id: "temperature", name: "ประเภท", options: [option("temperature", "ร้อน"), option("temperature", "เย็น", 5)] }),
      group({ id: "milk", name: "ประเภทนม", options: [option("milk", "นมสด"), option("milk", "นมโอ๊ต")] }),
      group({
        id: "sweetness",
        name: "ระดับความหวาน",
        options: [option("sweetness", "0%"), option("sweetness", "50%"), option("sweetness", "100%")],
      }),
    ]);

    expect(selections.temperature?.map((item) => item.name)).toEqual(["เย็น"]);
    expect(selections.milk?.map((item) => item.name)).toEqual(["นมสด"]);
    expect(selections.sweetness?.map((item) => item.name)).toEqual(["100%"]);
  });

  it("prefers configured isDefault options over POS name fallbacks", async () => {
    expect(existsSync(helperPath)).toBe(true);
    const { buildDefaultModifierSelections } = await import("@/modules/pos/default-modifiers");

    const selections = buildDefaultModifierSelections([
      group({
        id: "temperature",
        name: "ประเภท",
        options: [option("temperature", "ร้อน", 0, true), option("temperature", "เย็น", 5)],
      }),
    ]);

    expect(selections.temperature?.map((item) => item.name)).toEqual(["ร้อน"]);
  });

  it("does not fallback-select optional add-ons unless they are explicitly configured default", async () => {
    expect(existsSync(helperPath)).toBe(true);
    const { buildDefaultModifierSelections } = await import("@/modules/pos/default-modifiers");

    const fallbackSelections = buildDefaultModifierSelections([
      group({
        id: "extra-milk",
        name: "เพิ่มนม",
        selectionType: "multiple",
        isRequired: false,
        minSelections: 0,
        maxSelections: 2,
        options: [option("extra-milk", "นมสด", 10)],
      }),
    ]);

    expect(fallbackSelections["extra-milk"]).toBeUndefined();

    const configuredSelections = buildDefaultModifierSelections([
      group({
        id: "extra-milk",
        name: "เพิ่มนม",
        selectionType: "multiple",
        isRequired: false,
        minSelections: 0,
        maxSelections: 2,
        options: [option("extra-milk", "นมสด", 10, true)],
      }),
    ]);

    expect(configuredSelections["extra-milk"]?.map((item) => item.name)).toEqual(["นมสด"]);
  });
});
