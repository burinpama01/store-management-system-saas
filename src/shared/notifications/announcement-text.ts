/**
 * ประโยคที่ระบบอ่านออกเสียงเมื่อมีออเดอร์/แจ้งเตือนเข้า
 *
 * แยกออกมาเป็นโมดูลบริสุทธิ์เพราะ 2 เหตุผล:
 *   1) ทดสอบได้โดยไม่ต้องโหลด client component (ที่ลาก supabase/เครื่องพิมพ์มาด้วย)
 *   2) ข้อความพวกนี้ออกลำโพงหน้าร้านที่ลูกค้าได้ยิน จึงต้องรวมไว้ที่เดียวให้ตรวจง่ายว่า
 *      ไม่มีชื่อลูกค้า เบอร์โทร หรือยอดเงินหลุดออกไป
 */

/** ออเดอร์จาก QR ของลูกค้า — บอกเลขโต๊ะเพราะพนักงานต้องรู้ว่าจะเดินไปไหน */
export function qrOrderAnnouncement(tableNumber: string | undefined, queueLength: number): string {
  // เขียน "คิวอาร์" เป็นคำไทย เพราะเสียงไทยอ่าน "QR" ไม่ออก (ข้ามไปเฉย ๆ หรืออ่านทีละตัวอักษร)
  const head = tableNumber ? `ออเดอร์โต๊ะ ${tableNumber} เข้าใหม่` : "ออเดอร์คิวอาร์เข้าใหม่";
  return queueLength > 1 ? `${head} รออยู่ ${queueLength} รายการ` : head;
}

/** ออเดอร์เดลิเวอรีผ่าน Connect (JDC) — ไม่บอกยอดเงินและไม่บอกเลขบิล */
export function deliveryAnnouncement(queueLength: number): string {
  return queueLength > 1
    ? `ออเดอร์เดลิเวอรีเข้าใหม่ ${queueLength} รายการ`
    : "ออเดอร์เดลิเวอรีเข้าใหม่";
}

/**
 * toast แจ้งเตือนทั่วไป — อ่านแค่ "ชนิด" ของแจ้งเตือน
 * ไม่อ่านเนื้อข้อความเต็ม เพราะข้อความมีชื่อร้าน ยอดเงิน และชื่อพนักงานปนอยู่
 */
export function toastAnnouncement(typeLabel: string, count: number): string {
  return count > 1 ? `${typeLabel} ${count} รายการ` : typeLabel;
}
