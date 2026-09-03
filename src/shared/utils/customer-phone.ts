/**
 * รูปแบบเดียวของ "เบอร์ลูกค้า" ที่เก็บลงฐานข้อมูลและใช้ค้นหา
 *
 * ที่มาของปัญหา (audit 2026-07-19 ข้อ 2): หน้าแดชบอร์ดเก็บเบอร์แบบ trim อย่างเดียว
 * ("081-234-5678" คงขีดไว้) แต่ member portal normalize ก่อนเทียบแบบตรงตัว
 * → ลูกค้าที่พนักงานสร้างให้ ล็อกอินไม่เจอ และถ้าสมัครใหม่ก็จะได้อีกแถว = "แต้มหาย"
 *
 * กติกา: ตัดช่องว่าง วงเล็บ และขีด ออกให้หมด (คงตัวเลขและ + ไว้ตามเดิม)
 * — เป็นกฎเดียวกับที่ member portal ใช้มาก่อนหน้านี้ ข้อมูลเดิมจึงไม่เปลี่ยนความหมาย
 *
 * หมายเหตุ: คนละเรื่องกับ normalizePhoneNumber ใน printing/promptpay-qr.ts
 * ซึ่งแปลงเบอร์เป็นรูปแบบ PromptPay 13 หลัก ("0066…") สำหรับสร้าง QR โดยเฉพาะ
 */
export function normalizeCustomerPhone(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/[\s()-]/g, "");
}

/** คืน null เมื่อไม่มีเบอร์ — ใช้ตอนเขียนลงคอลัมน์ที่ nullable */
export function normalizeCustomerPhoneOrNull(value: string | null | undefined): string | null {
  return normalizeCustomerPhone(value) || null;
}
