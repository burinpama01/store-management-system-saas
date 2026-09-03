// แต้มเก็บเป็น numeric(12,2) ตั้งแต่ migration 20260626140000
// ฟอร์มปรับแต้มจึงต้องรับทศนิยมได้ (เดิมบังคับจำนวนเต็ม ทำให้หักล้างเศษแต้มไม่ได้เลย)

/** จำนวนแต้มสูงสุดต่อการปรับ 1 ครั้ง (กันพิมพ์พลาดเป็นค่ามหาศาล) */
export const MAX_POINTS_ADJUSTMENT = 100000;

/** ทศนิยมที่ฐานข้อมูลเก็บได้จริง */
export const POINTS_DECIMALS = 2;

/**
 * แปลงค่าที่กรอกเป็นจำนวนแต้มที่ปรับได้ — คืน null เมื่อใช้ไม่ได้
 * ปัดเป็น 2 ตำแหน่งให้ตรงกับที่ฐานข้อมูลเก็บ เพื่อไม่ให้ยอดบนจอกับในฐานข้อมูลต่างกัน
 */
export function parsePointsDeltaInput(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(value)) return null;

  // ปัดผ่าน exponential notation แทนการคูณ/หารด้วย 100
  // เพราะ 1.005 * 100 ในเลขทศนิยมฐานสองได้ 100.49999999999999 แล้วจะปัดลงเป็น 1.00
  // (แยกเครื่องหมายออกก่อน เพื่อให้ค่าลบปัดแบบสมมาตรกับค่าบวก: -1.005 → -1.01)
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  const scaled = Math.round(Number(`${magnitude}e${POINTS_DECIMALS}`));
  const rounded = sign * Number(`${scaled}e-${POINTS_DECIMALS}`);
  if (rounded === 0) return null;
  if (Math.abs(rounded) > MAX_POINTS_ADJUSTMENT) return null;
  return rounded;
}
