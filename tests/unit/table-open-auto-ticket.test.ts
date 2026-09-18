import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTableTicket, createTableTicketNumber, isEmptyTicket } from "@/modules/pos/table-ticket";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("table ticket helpers", () => {
  it("numbers tickets with the store's local time, not the server clock", () => {
    // 2026-09-18 03:05 UTC = 10:05 Asia/Bangkok
    const date = new Date("2026-09-18T03:05:00.000Z");
    expect(createTableTicketNumber(date, "Asia/Bangkok")).toMatch(/^T1005-\d{4}$/);
    expect(createTableTicketNumber(date, "Not/AZone")).toMatch(/^T0305-\d{4}$/);
  });

  it("builds an empty ticket bound to the table", () => {
    const ticket = buildTableTicket({
      id: "t-1",
      storeId: "s-1",
      tableId: "table-1",
      tableLabel: "A5",
      now: new Date("2026-09-18T03:05:00.000Z"),
      timeZone: "Asia/Bangkok",
    });
    expect(ticket.label).toBe("โต๊ะ A5");
    expect(ticket.tableId).toBe("table-1");
    expect(ticket.tableNumber).toBe("A5");
    expect(ticket.cart).toEqual({ storeId: "s-1", items: [], subtotal: 0, discount: 0, total: 0 });
    expect(isEmptyTicket(ticket)).toBe(true);
  });
});

describe("table open → ticket wiring", () => {
  const actions = read("src/app/pos/actions.ts");

  it("opens a ticket only when the store setting is on, and never fails the table open", () => {
    expect(actions).toContain("store?.tableOpenAutoTicket");
    expect(actions).toContain("async function ensureTableTicket(");
    const helper = actions.slice(actions.indexOf("async function ensureTableTicket("), actions.indexOf("/** Open an à la carte table session"));
    expect(helper).toContain("t.tableId === tableId");
    expect(helper).toContain("return null;");
    expect(helper).toContain("logSystemEvent");
  });

  it("keeps empty tickets out of bills and checkout", () => {
    const bills = actions.slice(actions.indexOf("export async function listTableBillsAction"), actions.indexOf("export async function settleWholeTableAction"));
    expect(bills).toContain("isEmptyTicket(ticket)");
    const settle = actions.slice(actions.indexOf("export async function settleWholeTableAction"), actions.indexOf("export async function voidOrderAction"));
    expect(settle).toContain("tableTickets.filter((t) => !isEmptyTicket(t))");
    expect(settle).toContain("deleteEmptyTableTickets");
  });

  it("routes a table ticket with QR orders to whole-table settlement instead of cart-only payment", () => {
    const pos = read("src/app/pos/PosTerminal.tsx");
    expect(pos).toContain("listOpenQrOrdersAction");
    expect(pos).toContain("tableQr={activeTableQr}");
    expect(pos).toContain("onSettleTable={handleSettleTableFromTicket}");
    const checkout = pos.slice(pos.indexOf("function handleCartCheckout()"), pos.indexOf("function handleTableSettled("));
    expect(checkout).toContain("handleSettleTableFromTicket()");
    expect(pos).toContain("onSettled={handleTableSettled}");
  });
});
