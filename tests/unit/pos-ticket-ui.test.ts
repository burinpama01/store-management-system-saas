import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("POS ticket UX guards", () => {
  it("supports saving, recalling, re-saving, deleting, and printing order tickets", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("POS_TICKET_STORAGE_PREFIX");
    expect(source).toContain("SavedOrderTicket");
    expect(source).toContain("handleSaveTicket");
    expect(source).toContain("handleLoadTicket");
    expect(source).toContain("handleDeleteTicket");
    expect(source).toContain("handlePrintTicket");
    expect(source).toContain("ใบสั่งออเดอร์");
    expect(source).toContain("ไม่ใช่ใบเสร็จ");
  });

  it("moves the order panel into a full-screen drawer below desktop widths", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("orderPanelOpen");
    expect(source).toContain("เปิดออร์เดอร์");
    expect(source).toContain("fixed inset-0 z-50");
    expect(source).toContain('role="dialog"');
    expect(source).toContain("aria-hidden={!orderPanelOpen ? true : undefined}");
    expect(source).toContain("inert={!orderPanelOpen ? true : undefined}");
    expect(source).toContain("hidden border-l border-gray-200 bg-white lg:flex");
    expect(source).toContain("lg:w-80");
  });

  it("shows full item details for variants, modifier groups, modifier prices, and item notes", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("modifierGroupName");
    expect(source).toContain("priceAdjustment !== 0");
    expect(source).toContain("หมายเหตุรายการ");
    expect(source).toContain("item.note");
  });

  it("writes saved tickets to localStorage before updating in-memory ticket state", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const writeIndex = source.indexOf("if (!writeSavedTickets(storeId, next))");
    const stateIndex = source.indexOf("setSavedTickets(next)");

    expect(writeIndex).toBeGreaterThan(-1);
    expect(stateIndex).toBeGreaterThan(writeIndex);
  });
});
