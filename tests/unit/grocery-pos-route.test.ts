import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("dedicated grocery POS route", () => {
  it("uses a dedicated grocery terminal instead of turning the current POS terminal into a grocery mode", () => {
    const page = read("src/app/pos/grocery/page.tsx");
    const terminal = read("src/app/pos/grocery/GroceryPosTerminal.tsx");

    expect(page).toContain("GroceryPosTerminal");
    expect(page).toContain('requirePermission("pos.use")');
    expect(page).toContain('requireFeature("groceryPos")');
    expect(page).not.toContain('from "../PosTerminal"');
    expect(page).not.toContain('from "./PosTerminal"');
    expect(terminal).toContain("addBarcodeMatchToGroceryCart");
    expect(terminal).toContain("applyScannerKey");

    const actions = read("src/app/pos/grocery/actions.ts");
    expect(actions).toContain('requireFeature("groceryPos")');
  });
});
