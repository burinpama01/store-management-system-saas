import { emptyCart } from "./cart";
import type { SavedOrderTicket } from "./types";

/**
 * ตั๋วของโต๊ะที่ POS เปิดรอไว้ตอน "เปิดโต๊ะ" — ออเดอร์ QR ของโต๊ะไม่ถูกคัดลอกเข้าตะกร้า
 * แต่ผูกกันด้วย tableId แล้วแสดงในตั๋วเป็นรายการ "ส่งครัวแล้ว" (ยอดไม่ซ้ำ ไม่แตะครัว/สต็อก)
 */

/**
 * ป้ายของบิลที่รวมทั้งโต๊ะ (consolidate_table_bill) — ในรายงานนับรวมช่องทาง QR ไม่แยกช่องทาง
 * แต่ทุกที่ที่บิลนี้ปรากฏต้องบอกชัดว่าเป็นบิลรวม (ออเดอร์ QR + รายการหน้าร้านของโต๊ะ)
 */
export const TABLE_BILL_LABEL = "บิลรวมโต๊ะ";

export function tableBillLabel(tableNumber?: string | null): string {
  return tableNumber ? `${TABLE_BILL_LABEL} · โต๊ะ ${tableNumber}` : TABLE_BILL_LABEL;
}

/** เลขตั๋วแบบเดียวกับที่ POS สร้าง (Thhmm-xxxx) แต่ใช้เวลาของร้าน ไม่ใช่เวลาเซิร์ฟเวอร์ */
export function createTableTicketNumber(date: Date, timeZone: string): string {
  let hh = String(date.getUTCHours()).padStart(2, "0");
  let mm = String(date.getUTCMinutes()).padStart(2, "0");
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    hh = parts.find((p) => p.type === "hour")?.value ?? hh;
    mm = parts.find((p) => p.type === "minute")?.value ?? mm;
  } catch {
    // timezone ของร้านไม่ถูกต้อง → ใช้ UTC แทน (เลขตั๋วใช้แสดงผลเท่านั้น)
  }
  return `T${hh}${mm}-${String(date.getTime()).slice(-4)}`;
}

export function buildTableTicket(input: {
  id: string;
  storeId: string;
  tableId: string;
  tableLabel: string;
  now: Date;
  timeZone: string;
}): SavedOrderTicket {
  const nowIso = input.now.toISOString();
  return {
    id: input.id,
    ticketNumber: createTableTicketNumber(input.now, input.timeZone),
    label: `โต๊ะ ${input.tableLabel}`,
    cart: emptyCart(input.storeId),
    tableId: input.tableId,
    tableNumber: input.tableLabel,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** ตั๋วที่ยังไม่มีรายการ — ห้ามส่งเข้า checkout (ตะกร้าว่าง) และไม่นับเป็นบิลค้าง */
export function isEmptyTicket(ticket: Pick<SavedOrderTicket, "cart">): boolean {
  return !ticket.cart || !Array.isArray(ticket.cart.items) || ticket.cart.items.length === 0;
}
