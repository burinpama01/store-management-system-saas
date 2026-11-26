import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { onlineOrderIdFromMetadata } from "@/modules/notifications/online-order-link";

const read = (p: string) => readFileSync(p, "utf8");
const ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("R1 ตั๋วออนไลน์ใน POS — ลิงก์จากแจ้งเตือน", () => {
  it("ดึง onlineOrderId จาก metadata ได้เฉพาะ uuid", () => {
    expect(onlineOrderIdFromMetadata({ onlineOrderId: ID })).toBe(ID);
    expect(onlineOrderIdFromMetadata({ onlineOrderId: "../../x" })).toBeNull();
    expect(onlineOrderIdFromMetadata({ onlineOrderId: 1 })).toBeNull();
    expect(onlineOrderIdFromMetadata(null)).toBeNull();
    expect(onlineOrderIdFromMetadata([ID])).toBeNull();
  });

  it("ตัวแจ้งเตือน: กดออเดอร์ออนไลน์ไปเปิดตั๋วใน POS + ยิง event ให้รายการตั๋วโหลดใหม่", () => {
    const src = read("src/app/(dashboard)/NotificationGlobalNotifier.tsx");
    expect(src).toContain("`/pos?online=${toast.onlineOrderId}`");
    expect(src).toContain("window.dispatchEvent(new Event(ONLINE_ORDER_REFRESH_EVENT))");
    expect(src).toContain("onlineOrderId: onlineOrderIdFromMetadata(row.metadata)");
    expect(read("src/app/(dashboard)/notifications/actions.ts")).toContain("onlineOrderId: onlineOrderIdFromMetadata(n.metadata)");
  });

  it("dispatcher ใส่ onlineOrderId ใน metadata ของแจ้งเตือนออเดอร์ออนไลน์อยู่แล้ว", () => {
    expect(read("src/modules/online-orders/notify.ts")).toContain("metadata: { onlineOrderId: order.id");
  });
});

describe("R1 ตั๋วออนไลน์ใน POS — หน้า POS", () => {
  const terminal = read("src/app/pos/PosTerminal.tsx");
  const tickets = read("src/app/pos/OnlineOrderTickets.tsx");

  it("POS อ่าน ?online= แล้วเปิดตั๋ว และล้างพารามิเตอร์ตอนปิด", () => {
    expect(terminal).toContain('searchParams.get("online")');
    expect(terminal).toContain("<OnlineOrderTicketDialog");
    expect(terminal).toContain('window.history.replaceState(null, "", window.location.pathname)');
  });

  it("แถบตั๋วมีหมวดออนไลน์ และนับรวมในป้ายจำนวนตั๋ว", () => {
    expect(terminal).toContain("<OnlineOrderTicketList orders={onlineOrders}");
    expect(terminal.match(/savedTicketCount=\{savedTickets\.length \+ onlineOrders\.length\}/g)?.length).toBe(2);
  });

  it("ตั๋วออนไลน์ไม่มีเก็บเงิน/ยกเลิก/คืนเงินใน POS (กันเก็บเงินซ้ำ)", () => {
    expect(tickets).not.toContain("refund_pending: \"");
    expect(tickets).not.toMatch(/addPaymentAndClose|checkoutAndPay/);
    expect(tickets).toContain("ไม่ต้องเก็บเงิน");
  });

  it("รีวิว: dialog remount ต่อออเดอร์ + บิลยังไม่ปิดห้ามเลื่อนสถานะ + ปิดบิลซ้ำเฉพาะ accepted", () => {
    expect(terminal).toContain("key={focusedOnlineOrder.id}");
    expect(tickets).toContain('const needsBillRetry = billPending && order.status === "accepted"');
    expect(tickets).toContain('order.status === "paid" || billPending ? []');
  });

  it("ตั๋วครัวรับที่ร้านเขียน 'รับที่ร้าน'", () => {
    const kitchen = read("src/app/(dashboard)/delivery/print-kitchen.ts");
    expect(kitchen.match(/opts\.fulfillment === "pickup" \? "รับที่ร้าน" : "เดลิเวอรี"/g)?.length).toBe(2);
  });

  it("polling: มีตั๋วค้าง 30 วิ / ไม่มี 2 นาที / แท็บซ่อนไม่ถาม", () => {
    expect(tickets).toContain("POLL_ACTIVE_MS = 30_000");
    expect(tickets).toContain("POLL_IDLE_MS = 120_000");
    expect(tickets).toContain('document.visibilityState === "visible"');
  });

  it("เปิดเฉพาะร้านที่เปิดสั่งออนไลน์ + จัดการออเดอร์ได้ + Enterprise", () => {
    const page = read("src/app/pos/page.tsx");
    expect(page).toContain('resolved.can("orders.manage_qr")');
    expect(page).toContain("isOnlineOrderingEnabled(ctx.storeId)");
    expect(page).toContain("onlineOrdersEnabled={onlineOrdersEnabled}");
  });

  it("หน้า สั่งออนไลน์: รับแล้วพาไปตั๋วใน POS", () => {
    expect(read("src/app/(dashboard)/website/orders/OnlineOrdersBoard.tsx")).toContain("router.push(`/pos?online=${o.id}`)");
  });
});
