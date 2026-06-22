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
    expect(terminal).toContain('href="/pos/grocery/display"');
    expect(terminal).toContain("เปิดจอคู่ร้านของชำ");
    expect(terminal).toContain("var(--color-bg)");
    expect(terminal).toContain("var(--color-surface)");
    expect(terminal).not.toContain("background: #f6f8fb");

    const actions = read("src/app/pos/grocery/actions.ts");
    expect(actions).toContain('requireFeature("groceryPos")');
  });

  it("keeps grocery and customer display entry points visible from catalog tools", () => {
    const catalog = read("src/app/(dashboard)/catalog/CatalogManager.tsx");
    const display = read("src/app/pos/grocery/display/CustomerDisplayScreen.tsx");

    expect(catalog).toContain('href="/pos/display"');
    expect(catalog).toContain("เปิดจอคู่ POS");
    expect(catalog).toContain('href="/pos/grocery"');
    expect(catalog).toContain("เปิด Grocery POS");
    expect(catalog).toContain('href="/pos/grocery/display"');
    expect(catalog).toContain("เปิดจอคู่ Grocery");
    expect(display).toContain("var(--color-bg)");
    expect(display).toContain("var(--color-brand)");
    expect(display).not.toContain("background: #101828");
  });
});
