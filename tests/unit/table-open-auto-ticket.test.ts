import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildTableTicket, createTableTicketNumber, isEmptyTicket } from "@/modules/pos/table-ticket";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const slice = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  expect(start, `ไม่พบ ${from}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(to, start + from.length);
  return source.slice(start, end === -1 ? undefined : end);
};

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

describe("table bill wiring (review PR #62)", () => {
  const actions = read("src/app/pos/actions.ts");
  const pos = read("src/app/pos/PosTerminal.tsx");

  it("creates the auto ticket atomically in the DB and never fails the table open", () => {
    expect(actions).toContain("store?.tableOpenAutoTicket");
    const helper = slice(actions, "async function ensureTableTicket(", "/** Open an à la carte table session");
    expect(helper).toContain("ensureTableAutoTicket(");
    expect(helper).not.toContain("listSavedTickets(");
    expect(helper).toContain("return null;");
    expect(helper).toContain("safeLog(");
  });

  it("money paths read table tickets without the 30-ticket UI limit", () => {
    const bills = slice(actions, "export async function listTableBillsAction", "export async function settleWholeTableAction");
    expect(bills).toContain("listTableSavedTickets(ctx.storeId)");
    expect(bills).toContain("isEmptyTicket(ticket)");
    const settle = slice(actions, "export async function settleWholeTableAction", "export async function voidOrderAction");
    expect(settle).toContain("listTableSavedTickets(ctx.storeId, tableId)");
    const repo = read("src/modules/pos/saved-ticket-repository.ts");
    const tableQuery = slice(repo, "export async function listTableSavedTickets", "export async function ensureTableAutoTicket");
    expect(tableQuery).not.toContain(".limit(");
  });

  it("logging is best-effort", () => {
    const safeLog = slice(actions, "function safeLog(", "async function getStoreContext");
    expect(safeLog).toContain(".catch(() => undefined)");
  });

  it("a table ticket always checks out the whole table as one bill through the normal POS payment panel", () => {
    const checkout = slice(pos, "function handleCartCheckout()", "function handleCheckoutTableFromBill(");
    expect(checkout).toContain("if (activeTicket?.tableId)");
    expect(checkout).toContain("handleSettleTableFromTicket()");
    const start = slice(pos, "function startTableBillPayment(", "function handleSettleTableFromTicket()");
    expect(start).toContain("consolidateTableBillAction(");
    expect(start).toContain("setPendingOrder(result.order)");
    expect(start).toContain('setPhase("payment")');
    // หลังจ่าย: ปิดโต๊ะผ่าน server
    expect(pos).toContain("finishTableBillAction(paidTableBill.tableId, order.orderId)");
  });

  it("the table bill modal hands payment to the POS panel and hides PromptPay for Beam stores", () => {
    expect(pos).toContain("onCheckout={(tableId) => handleCheckoutTableFromBill(tableId)}");
    expect(pos).toContain("hidePromptPayQr={hidePromptPayQr && beamEnabled}");
    const modal = read("src/app/pos/TableBillModal.tsx");
    expect(modal).toContain("showQrPayment: unpaid && !hidePromptPayQr");
    expect(modal).toContain("{onCheckout ? (");
  });

  it("consolidation refuses kitchen-pending orders and finishing verifies the bill was paid", () => {
    const consolidate = slice(actions, "export async function consolidateTableBillAction", "export async function finishTableBillAction");
    expect(consolidate).toContain('o.prepStatus === "new"');
    expect(consolidate).toContain('rpc("consolidate_table_bill"');
    const finish = slice(actions, "export async function finishTableBillAction", "export async function voidTableQrItemAction");
    expect(finish).toContain('bill.status !== "paid"');
    expect(finish).toContain("closeTableSession(ctx.storeId, tableId)");
    const migration = read("supabase/migrations/20260918040000_table_bill_consolidation.sql");
    expect(migration).toContain("ยังมีออเดอร์ที่ครัวยังไม่รับ");
    expect(migration).toContain("on conflict (store_id, table_id) where ticket_source = 'table_auto' do nothing");
  });
});
