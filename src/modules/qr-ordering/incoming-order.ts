/**
 * ตัดสินว่า realtime event ของตาราง orders เป็น "ออเดอร์ QR ใหม่ที่ครัวต้องทำ" หรือไม่
 *
 * บิลรวมโต๊ะ (consolidate_table_bill) INSERT ออเดอร์ใหม่ด้วย qr_order_source=true
 * แล้วย้ายรายการของทุกรอบเข้ามา — รายการเหล่านั้นครัวรับ/ทำไปแล้ว จึงต้องไม่เด้ง
 * แจ้งเตือน ไม่ประกาศเสียง และไม่พิมพ์ตั๋วครัวซ้ำ (ระบุด้วย table_bill_key)
 */
export interface OrderRealtimeEventLike {
  eventType: string;
  new?: {
    qr_order_source?: boolean | null;
    table_bill_key?: string | null;
  } | null;
}

export function isNewKitchenQrOrderEvent(payload: OrderRealtimeEventLike): boolean {
  if (payload.eventType !== "INSERT") return false;
  const row = payload.new;
  if (!row?.qr_order_source) return false;
  if (row.table_bill_key) return false;
  return true;
}
