// หลังล็อกอินพากลับไปหน้าที่ผู้ใช้ตั้งใจจะเปิด (เช่น /player/<slug> บนเครื่องใหม่)
// รับเฉพาะ path ภายในเว็บเราเท่านั้น กัน open redirect (//evil.com, /\evil.com, https://...)

export const RETURN_TO_PARAM = "next";

// path+query ของหน้าในระบบยาวไม่ถึงนี้ — ยาวกว่านี้ถือว่าผิดปกติ
const MAX_LENGTH = 512;

// หน้าที่ไม่ควรเด้งกลับไป: หน้า auth เอง (วนลูป) และ API (ไม่ใช่หน้าเว็บ)
const BLOCKED_ROOTS = ["/login", "/register", "/reset-password", "/update-password", "/auth", "/api"];

/** คืน path ภายในที่ปลอดภัย หรือ null ถ้าใช้ไม่ได้ */
export function sanitizeReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_LENGTH) return null;
  if (!value.startsWith("/")) return null;
  // "//host" และ "/\host" เบราว์เซอร์ตีความเป็นโดเมนอื่น
  if (value.startsWith("//") || value.includes("\\")) return null;
  // ตัวอักษรควบคุม (แท็บ/ขึ้นบรรทัด) เบราว์เซอร์ตัดทิ้งแล้วอาจกลายเป็น "//"
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value, "https://storeos.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://storeos.invalid") return null;

  const path = parsed.pathname;
  if (path === "/") return null;
  // กันรูปแบบเข้ารหัส เช่น /%2F%2Fevil.com หรือ /%5C/evil.com (กันไว้อีกชั้น แม้เบราว์เซอร์จะไม่ถอดรหัสเอง)
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || decoded.includes("\\")) return null;
  // ตรวจทั้งแบบดิบและแบบถอดรหัส — /%2flogin ต้องถูกกันเหมือน /login (ไม่งั้นวนกลับหน้าล็อกอิน)
  for (const candidate of [path.toLowerCase(), decoded.toLowerCase()]) {
    if (BLOCKED_ROOTS.some((root) => candidate === root || candidate.startsWith(`${root}/`))) return null;
  }
  // ตัด #fragment ทิ้งโดยตั้งใจ (ไม่ถูกส่งถึง server และไม่จำเป็นต่อการกลับหน้าเดิม)
  return `${path}${parsed.search}`;
}

/** path+query ของหน้าที่ถูกเด้งไปล็อกอิน → ค่า next ที่จะแนบ (หรือ null ถ้าไม่ควรแนบ) */
export function returnToForLoginRedirect(pathname: string, search: string): string | null {
  return sanitizeReturnTo(`${pathname}${search}`);
}
