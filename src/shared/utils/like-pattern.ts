/**
 * escape ตัวอักษรพิเศษของ SQL LIKE/ILIKE ก่อนนำค่าที่ผู้ใช้กรอกไปค้นหา
 *
 * "_" = อักขระใดก็ได้ 1 ตัว, "%" = อักขระใดก็ได้กี่ตัวก็ได้
 * ถ้าไม่ escape อีเมลอย่าง "a_b@x.com" จะไปจับ "aab@x.com" ได้ = เข้าบัญชีคนอื่น
 * (ต้อง escape backslash ด้วย เพราะเป็นตัว escape ของ pattern เอง)
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
