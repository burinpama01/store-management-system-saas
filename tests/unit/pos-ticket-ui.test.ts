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
    expect(source).toContain("listSavedTicketsAction");
    expect(source).toContain("saveSavedTicketAction");
    expect(source).toContain("deleteSavedTicketAction");
    expect(source).toContain("mergeSavedTickets");
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

  it("keeps a local ticket cache after syncing tickets with the server", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const writeIndex = source.indexOf("if (!writeSavedTickets(storeId, next))");
    const stateIndex = source.indexOf("setSavedTickets(next)");

    expect(writeIndex).toBeGreaterThan(-1);
    expect(stateIndex).toBeGreaterThan(writeIndex);
    expect(source).toContain("startTicketTransition");
    expect(source).toContain("saveSavedTicketAction(ticket)");
    expect(source).toContain("deleteSavedTicketAction(ticketId, { closeRelatedTableSession })");
  });

  it("does not clear a paid ticket from local cache when server delete fails", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const deleteIndex = source.indexOf("const deleteResult = await deleteSavedTicketAction(activeTicketId)");
    const errorIndex = source.indexOf("if (deleteResult.error)");
    const clearIndex = source.indexOf("persistSavedTickets(savedTickets.filter((ticket) => ticket.id !== activeTicketId))");

    expect(deleteIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeGreaterThan(deleteIndex);
    expect(clearIndex).toBeGreaterThan(errorIndex);
    expect(source.slice(errorIndex, clearIndex)).toContain("} else {");
  });

  it("shows rich ticket context and searchable saved ticket states", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("ticketSearch");
    expect(source).toContain("filteredSavedTickets");
    expect(source).toContain("ticket.tableNumber");
    expect(source).toContain("ticket.customerName");
    expect(source).toContain("ticket.note");
    expect(source).toContain("ticket.syncState");
    expect(source).toContain("ticket.lastSyncedAt");
    expect(source).toContain("ค้นหาตั๋ว/โต๊ะ/ลูกค้า");
  });

  it("adds bill history, reprint, void, and print feedback to the POS surface", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("listTodayOrdersAction");
    expect(source).toContain("voidOrderAction");
    expect(source).toContain("BillHistoryPanel");
    expect(source).toContain("handleRefreshBillHistory");
    expect(source).toContain("handlePrintHistoryOrder");
    expect(source).toContain("handleVoidHistoryOrder");
    expect(source).toContain("printStatusMessage");
    expect(source).toContain("พิมพ์ซ้ำ");
    expect(source).toContain("บิลวันนี้");
  });

  it("requires QR verification and carries saved ticket table metadata into checkout", () => {
    const source = read("src/app/pos/PosTerminal.tsx");

    expect(source).toContain("qrPaymentVerified");
    expect(source).toContain("ยืนยันว่าได้รับเงิน QR แล้ว");
    expect(source).toContain("checkoutTicketContext");
    expect(source).toContain("tableId: checkoutTicketContext.tableId");
    expect(source).toContain("tableNumber: checkoutTicketContext.tableNumber");
    expect(source).toContain("note: checkoutTicketContext.note");
    expect(source).toContain("qrPaymentVerified: method === \"qr_promptpay\" ? qrPaymentVerified : undefined");
    expect(source).toContain("ticket.syncState === \"sync_failed\"");
    expect(source).toContain("ลบตั๋วและเคลียร์โต๊ะ");
  });

  it("requires QR verification before settling table bills", () => {
    const source = read("src/app/pos/TableBillModal.tsx");

    expect(source).toContain("qrPaymentVerified");
    expect(source).toContain("ยืนยันว่าได้รับเงิน QR แล้ว");
    expect(source).toContain("qrReady");
    expect(source).toContain("qrPaymentVerified: method === \"qr_promptpay\" ? qrPaymentVerified : undefined");
  });
});
