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
    expect(source).toContain("aria-hidden={!orderPanelOpen || utilitySheetOpen ? true : undefined}");
    expect(source).toContain("inert={!orderPanelOpen || utilitySheetOpen ? true : undefined}");
    expect(source).toContain("hidden border-l border-gray-200 bg-white lg:flex");
    expect(source).toContain("lg:w-80");
  });

  it("keeps ticket tools and bill history behind dedicated pop-up sheets", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const cartPanelStart = source.indexOf("function CartPanel(");
    const cartPanelEnd = source.indexOf("function PosUtilitySheet(");
    const cartPanelSource = source.slice(cartPanelStart, cartPanelEnd);

    expect(source).toContain("ticketPanelOpen");
    expect(source).toContain("billHistoryPanelOpen");
    expect(source).toContain("utilitySheetOpen");
    expect(source).toContain("PosUtilitySheet");
    expect(source).toContain("เปิดตั๋ว");
    expect(source).toContain("ประวัติบิล");
    expect(source).toContain("TicketPanel");
    expect(source).toContain("<BillHistoryPanel");
    expect(source).toContain("sheetRef");
    expect(source).toContain("previousFocusRef");
    expect(source).toContain('data-pos-utility-sheet="true"');
    expect(source).toContain("historyMode");
    expect(source).toContain('max-h-[60dvh]');
    expect(source).toContain("visibleOrders.map((order)");
    expect(source).not.toContain("orders.slice(0, 8)");
    expect(source).toContain("function handleLoadTicket");
    expect(source).toContain("return true;");
    expect(cartPanelSource).not.toContain("ticketDraft");
    expect(cartPanelSource).not.toContain("filteredSavedTickets");
    expect(cartPanelSource).not.toContain("<BillHistoryPanel");
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

  it("loads saved ticket cache after mount so localStorage counts do not break hydration", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const savedTicketsStateIndex = source.indexOf("const [savedTickets, setSavedTickets]");
    const syncEffectIndex = source.indexOf("useEffect(() =>", savedTicketsStateIndex);
    const localReadIndex = source.indexOf("readSavedTickets(storeId)", savedTicketsStateIndex);

    expect(source).toContain("const [savedTickets, setSavedTickets] = useState<SavedOrderTicket[]>([])");
    expect(localReadIndex).toBeGreaterThan(syncEffectIndex);
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

  it("shows saved ticket item details and lets active tickets be saved back from the order drawer", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const summaryStart = source.indexOf("function ticketItemSummary");
    const summaryEnd = source.indexOf("function ticketTimeLabel");
    const summarySource = source.slice(summaryStart, summaryEnd);
    const cartPanelStart = source.indexOf("function CartPanel(");
    const cartPanelEnd = source.indexOf("function PosUtilitySheet(");
    const cartPanelSource = source.slice(cartPanelStart, cartPanelEnd);

    expect(source).toContain("ticketItemSummary");
    expect(source).toContain("ticket.cart.items.slice(0, 3).map");
    expect(summarySource).toContain("item.modifiers.map(modifierDetail)");
    expect(summarySource).toContain("item.note");
    expect(source).toContain("รายการอื่น");
    expect(cartPanelSource).toContain("onSaveTicket");
    expect(cartPanelSource).toContain("isTicketSyncPending");
    expect(cartPanelSource).toContain("บันทึกตั๋วใหม่");
    expect(cartPanelSource).toContain("บันทึกตั๋วกลับ");
    expect(cartPanelSource).toContain("activeTicket &&");
  });

  it("lets cashier apply and clear discounts directly from the order drawer", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const cartPanelStart = source.indexOf("function CartPanel(");
    const cartPanelEnd = source.indexOf("function PosUtilitySheet(");
    const cartPanelSource = source.slice(cartPanelStart, cartPanelEnd);

    expect(source).toContain("applyDiscount");
    expect(source).toContain("applyOrderDiscount");
    expect(source).toContain("discountAmount");
    expect(source).toContain("discountPercentage");
    expect(source).toContain("discountMode");
    expect(source).toContain("discountNote");
    expect(source).toContain("onApplyDiscount");
    expect(cartPanelSource).toContain("ส่วนลดท้ายบิล");
    expect(cartPanelSource).toContain("discountFormOpen");
    expect(cartPanelSource).toContain("const discountFormVisible = discountFormOpen && cart.items.length > 0");
    expect(cartPanelSource).toContain("onDiscountFormOpenChange(!discountFormVisible)");
    expect(cartPanelSource).toContain("aria-expanded={discountFormVisible}");
    expect(cartPanelSource).toContain("เรียกส่วนลดท้ายบิล");
    expect(cartPanelSource).toContain("discountFormVisible &&");
    expect(cartPanelSource).toContain('inputMode="decimal"');
    expect(cartPanelSource).toContain('aria-label="จำนวนส่วนลด"');
    expect(cartPanelSource).toContain('aria-label="เปอร์เซ็นต์ส่วนลด"');
    expect(cartPanelSource).toContain('aria-label="เหตุผลส่วนลด"');
    expect(cartPanelSource).toContain("discountMode === \"amount\"");
    expect(cartPanelSource).toContain("discountMode === \"percentage\"");
    expect(cartPanelSource).toContain("max=\"100\"");
    expect(cartPanelSource).toContain("ใช้ส่วนลด");
    expect(cartPanelSource).toContain("ล้างส่วนลด");
    expect(cartPanelSource).toContain("max={cart.subtotal}");
    expect(cartPanelSource).toContain("cart.discount > 0");
  });

  it("keeps item discount forms behind per-row disclosure controls", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const cartPanelStart = source.indexOf("function CartPanel(");
    const cartPanelEnd = source.indexOf("function PosUtilitySheet(");
    const itemRowStart = source.indexOf("function CartItemRow(");
    const itemRowEnd = source.indexOf("// ─── Payment Panel");
    const cartPanelSource = source.slice(cartPanelStart, cartPanelEnd);
    const itemRowSource = source.slice(itemRowStart, itemRowEnd);

    expect(source).toContain("applyItemDiscount");
    expect(source).toContain("removeItemDiscount");
    expect(source).toContain("handleApplyItemDiscount");
    expect(cartPanelSource).toContain("onApplyItemDiscount");
    expect(cartPanelSource).toContain("onClearItemDiscount");
    expect(cartPanelSource).toContain("canDiscount={canDiscount}");
    expect(itemRowSource).toContain("itemDiscountFormOpen");
    expect(itemRowSource).toContain("เรียกส่วนลดรายการนี้");
    expect(itemRowSource).toContain("ส่วนลดรายการนี้");
    expect(itemRowSource).toContain("(item.discount ?? 0) > 0");
    expect(itemRowSource).toContain("ล้างส่วนลดรายการ");
    expect(itemRowSource).toContain('aria-label="ประเภทส่วนลดรายการ"');
    expect(itemRowSource).toContain('aria-label="จำนวนส่วนลดรายการ"');
    expect(itemRowSource).toContain('aria-label="เปอร์เซ็นต์ส่วนลดรายการ"');
    expect(itemRowSource).toContain('aria-label="เหตุผลส่วนลดรายการ"');
    expect(itemRowSource).toContain("max={item.unitPrice * item.quantity}");
  });

  it("gates discount controls with the resolved pos.discount permission", () => {
    const pageSource = read("src/app/pos/page.tsx");
    const source = read("src/app/pos/PosTerminal.tsx");
    const cartPanelStart = source.indexOf("function CartPanel(");
    const cartPanelEnd = source.indexOf("function PosUtilitySheet(");
    const cartPanelSource = source.slice(cartPanelStart, cartPanelEnd);

    expect(pageSource).toContain('canDiscount={resolved.can("pos.discount")}');
    expect(source).toContain("canDiscount: boolean");
    expect(source).toContain("canDiscount={canDiscount}");
    expect(cartPanelSource).toContain("canDiscount &&");
    expect(cartPanelSource).toContain("disabled={!canApplyDiscount}");
  });

  it("keeps discount input draft in sync when the active cart is replaced", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const cartPanelStart = source.indexOf("function CartPanel(");
    const cartPanelEnd = source.indexOf("function PosUtilitySheet(");
    const cartPanelSource = source.slice(cartPanelStart, cartPanelEnd);
    const loadTicketStart = source.indexOf("function handleLoadTicket");
    const deleteTicketStart = source.indexOf("function handleDeleteTicket");
    const loadTicketSource = source.slice(loadTicketStart, deleteTicketStart);

    expect(source).toContain("type DiscountDraft");
    expect(source).toContain("discountDraftFromCart");
    expect(source).toContain("const [discountDraft, setDiscountDraft]");
    expect(cartPanelSource).toContain("discountAmount");
    expect(cartPanelSource).toContain("discountPercentage");
    expect(cartPanelSource).toContain("discountMode");
    expect(cartPanelSource).toContain("discountNote");
    expect(cartPanelSource).toContain("onDiscountDraftChange");
    expect(source).toContain("discountAmount={discountDraft.amount}");
    expect(source).toContain("discountPercentage={discountDraft.percentage}");
    expect(source).toContain("discountMode={discountDraft.mode}");
    expect(source).toContain("discountNote={discountDraft.note}");
    expect(source).toContain("function commitCart(nextCart: Cart, options: { resetItemDiscountForms?: boolean } = {})");
    expect(source).toContain("setDiscountDraft(discountDraftFromCart(nextCart))");
    expect(loadTicketSource).toContain("commitCart(ticket.cart, { resetItemDiscountForms: true })");
    expect(source).toContain("commitCart(emptyCart(storeId), { resetItemDiscountForms: true })");
  });

  it("resets the discount disclosure when the active cart is cleared or replaced", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const terminalStart = source.indexOf("export function PosTerminal");
    const cartPanelStart = source.indexOf("function CartPanel(");
    const cartPanelEnd = source.indexOf("function PosUtilitySheet(");
    const loadTicketStart = source.indexOf("function handleLoadTicket");
    const deleteTicketStart = source.indexOf("function handleDeleteTicket");
    const clearOrderStart = source.indexOf("function clearCurrentOrder");
    const applyDiscountStart = source.indexOf("function handleApplyDiscount(type");
    const terminalSource = source.slice(terminalStart);
    const cartPanelSource = source.slice(cartPanelStart, cartPanelEnd);
    const loadTicketSource = source.slice(loadTicketStart, deleteTicketStart);
    const clearOrderSource = source.slice(clearOrderStart, applyDiscountStart);

    expect(terminalSource).toContain("const [discountFormOpen, setDiscountFormOpen] = useState(false)");
    expect(cartPanelSource).toContain("discountFormOpen: boolean");
    expect(cartPanelSource).toContain("onDiscountFormOpenChange: (open: boolean) => void");
    expect(cartPanelSource).not.toContain("const [discountFormOpen, setDiscountFormOpen] = useState(false)");
    expect(source).toContain("if (nextCart.items.length === 0) {");
    expect(source).toContain("setDiscountFormOpen(false)");
    expect(clearOrderSource).toContain("setDiscountFormOpen(false)");
    expect(loadTicketSource).toContain("setDiscountFormOpen(false)");
  });

  it("resets item discount disclosure when the active cart is cleared or replaced", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const terminalStart = source.indexOf("export function PosTerminal");
    const loadTicketStart = source.indexOf("function handleLoadTicket");
    const deleteTicketStart = source.indexOf("function handleDeleteTicket");
    const clearOrderStart = source.indexOf("function clearCurrentOrder");
    const applyDiscountStart = source.indexOf("function handleApplyDiscount(type");
    const cartPanelStart = source.indexOf("function CartPanel(");
    const cartPanelEnd = source.indexOf("function PosUtilitySheet(");
    const terminalSource = source.slice(terminalStart);
    const loadTicketSource = source.slice(loadTicketStart, deleteTicketStart);
    const clearOrderSource = source.slice(clearOrderStart, applyDiscountStart);
    const cartPanelSource = source.slice(cartPanelStart, cartPanelEnd);

    expect(terminalSource).toContain("const [itemDiscountResetKey, setItemDiscountResetKey] = useState(0)");
    expect(terminalSource).toContain("resetItemDiscountForms?: boolean");
    expect(terminalSource).toContain("setItemDiscountResetKey((current) => current + 1)");
    expect(clearOrderSource).toContain("commitCart(emptyCart(storeId), { resetItemDiscountForms: true })");
    expect(loadTicketSource).toContain("commitCart(ticket.cart, { resetItemDiscountForms: true })");
    expect(cartPanelSource).toContain("itemDiscountResetKey: number");
    expect(cartPanelSource).toContain('key={`${item.key}-${itemDiscountResetKey}`}');
  });

  it("adds bill history, reprint, void, and print feedback to the POS surface", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const actionsSource = read("src/app/pos/actions.ts");
    const repositorySource = read("src/modules/pos/order-repository.ts");

    expect(source).toContain("listTodayOrdersAction");
    expect(source).toContain("listOrdersHistoryAction");
    expect(actionsSource).toContain("listOrdersHistoryAction");
    expect(repositorySource).toContain("export async function listOrdersHistory");
    expect(source).toContain("voidOrderAction");
    expect(source).toContain("BillHistoryPanel");
    expect(source).toContain("historyRange");
    expect(source).toContain("setHistoryRange");
    expect(source).toContain("historyRequestIdRef");
    expect(source).toContain("storeTimezone");
    expect(read("src/app/pos/page.tsx")).toContain("storeTimezone={ctx.storeTimezone}");
    expect(source).toContain("dateInputValue(date = new Date(), timeZone = \"Asia/Bangkok\")");
    expect(source).toContain("createHistoryRange(\"today\", storeTimezone)");
    expect(source).toContain('value="7d"');
    expect(source).toContain('value="30d"');
    expect(source).toContain('type="date"');
    expect(source).toContain("onHistoryRangeChange");
    expect(source).toContain("if (historyRequestIdRef.current !== requestId) return");
    expect(source).toContain('if (normalizedRange.mode !== "custom")');
    expect(source).toContain("handleRefreshBillHistory");
    expect(source).toContain("handlePrintHistoryOrder");
    expect(source).toContain("handleVoidHistoryOrder");
    expect(source).toContain("printStatusMessage");
    expect(source).toContain("พิมพ์ซ้ำ");
    expect(source).toContain("บิลย้อนหลัง");
  });

  it("shows bill history item details and resets ticket draft when clearing the desktop order drawer", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const summaryStart = source.indexOf("function orderItemSummary");
    const summaryEnd = source.indexOf("function ticketTimeLabel");
    const orderSummarySource = source.slice(summaryStart, summaryEnd);
    const historyStart = source.indexOf("function BillHistoryPanel(");
    const historyEnd = source.indexOf("function PaymentPanel(");
    const historySource = source.slice(historyStart, historyEnd);
    const renderStart = source.indexOf("function renderOrderPanelContent");
    const mobileDrawerStart = source.indexOf("{/* Mobile / tablet order drawer */}");
    const desktopOrderSource = source.slice(renderStart, mobileDrawerStart);

    expect(source).toContain("orderItemSummary");
    expect(source).toContain("order.items.slice(0, 3).map");
    expect(source).toContain("item.modifiers.map(modifierDetail)");
    expect(historySource).toContain("orderItemSummary(order)");
    expect(orderSummarySource).toContain("รายการอื่น");
    expect(desktopOrderSource).toContain("onClear={() => clearCurrentOrder()}");
    expect(source).toContain("setTicketDraft(EMPTY_TICKET_DRAFT)");
  });

  it("hides the mobile order drawer from assistive tech while ticket or bill sheets are open", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const mobileDrawerStart = source.indexOf("{/* Mobile / tablet order drawer */}");
    const mobileDrawerEnd = source.indexOf("<aside className");
    const mobileDrawerSource = source.slice(mobileDrawerStart, mobileDrawerEnd);

    expect(source).toContain("const utilitySheetOpen = ticketPanelOpen || billHistoryPanelOpen");
    expect(mobileDrawerSource).toContain('aria-modal={orderPanelOpen && !utilitySheetOpen ? "true" : undefined}');
    expect(mobileDrawerSource).toContain("aria-hidden={!orderPanelOpen || utilitySheetOpen ? true : undefined}");
    expect(mobileDrawerSource).toContain("inert={!orderPanelOpen || utilitySheetOpen ? true : undefined}");
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

  it("surfaces printer config load errors before using print fallback", () => {
    const source = read("src/app/pos/PosTerminal.tsx");
    const page = read("src/app/pos/page.tsx");

    expect(page).toContain("printerLoadError={printersResult.error?.userMessage ?? null}");
    expect(source).toContain("printerLoadError");
    expect(source).toContain("โหลดการตั้งค่าเครื่องพิมพ์ไม่สำเร็จ");
    expect(source).toContain("printSuccessMessage(");
    expect(source).toContain("ใช้ช่องทางสำรอง");
  });
});
