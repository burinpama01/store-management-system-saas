/**
 * คีย์เบอร์โทรระดับองค์กร — เบอร์เดียวกัน = สมาชิกคนเดียวกันทุกสาขา
 *
 * ต้องตรงกับฟังก์ชัน SQL public.member_phone_key() ใน
 * supabase/migrations/20261115120000_member_identity_redeem_codes.sql
 * เหลือแต่ตัวเลข แล้วแปลงรหัสประเทศไทย (66 / 0066) เป็น 0 นำหน้า
 */
export function memberPhoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^0-9]/g, "");
  if (/^0066[0-9]{9}$/.test(digits)) return `0${digits.slice(4)}`;
  if (/^66[0-9]{9}$/.test(digits)) return `0${digits.slice(2)}`;
  if (digits.length >= 9 && digits.length <= 15) return digits;
  return null;
}
