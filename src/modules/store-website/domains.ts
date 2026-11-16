/**
 * โดเมนของร้านเอง (S4) — ฟังก์ชันล้วน ใช้ทั้ง proxy, server action และหน้าตั้งค่า
 */

/** โดเมนหลักของ StoreOS (ไม่ใช่โดเมนร้าน) */
const PRIMARY_HOSTS = new Set(["store-os.online", "www.store-os.online", "localhost", "127.0.0.1", "[::1]"]);

/** host ของคำขอ (ตัดพอร์ต, ตัวเล็ก) */
export function hostOf(rawHost: string | null | undefined): string {
  if (!rawHost) return "";
  const host = rawHost.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0].replace(/\.$/, "");
}

/** คำขอนี้มาที่โดเมนของ StoreOS เอง (หรือ preview/dev) — ไม่ต้องหาว่าเป็นเว็บร้านไหน */
export function isPrimaryHost(host: string): boolean {
  if (!host) return true;
  if (PRIMARY_HOSTS.has(host)) return true;
  if (host.endsWith(".store-os.online") || host.endsWith(".vercel.app") || host.endsWith(".localhost")) return true;
  // IP ล้วน (เช่นทดสอบในวงแลน)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

export function normalizeDomain(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "");
  v = v.split(/[/?#]/)[0] ?? "";
  v = v.split(":")[0] ?? "";
  return v.replace(/\.$/, "");
}

const DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** ข้อผิดพลาดเป็นข้อความไทย หรือ null = ใช้ได้ */
export function validateDomain(domain: string): string | null {
  if (!domain) return "ใส่โดเมน เช่น www.ร้านของคุณ.com";
  if (domain.length > 253 || !DOMAIN_RE.test(domain)) return "รูปแบบโดเมนไม่ถูกต้อง (เช่น www.eachother.cafe) — โดเมนภาษาไทยให้ใช้รูปแบบ xn--";
  if (isPrimaryHost(domain)) return "ใช้โดเมนของ StoreOS ไม่ได้ — ใส่โดเมนที่ร้านจดเอง";
  return null;
}

/** โดเมนหลัก (apex) เช่น eachother.cafe ต้องใช้ A record · โดเมนย่อย เช่น www.eachother.cafe ใช้ CNAME */
export function isApexDomain(domain: string): boolean {
  const parts = domain.split(".");
  // ประมาณการ: 2 ส่วน = apex; โดเมนประเทศ 2 ชั้น (co.th, in.th, ac.th ...) 3 ส่วน = apex
  if (parts.length === 2) return true;
  return parts.length === 3 && /^(co|in|ac|or|go|net|com|org)$/.test(parts[1]) && parts[2].length === 2;
}

export const VERCEL_A_RECORD = "76.76.21.21";
export const VERCEL_CNAME = "cname.vercel-dns.com";

export type CustomDomainStatus = "none" | "pending" | "active" | "error";

/**
 * path บนโดเมนร้าน → path จริงในแอป
 * "/" → /s/<slug> · "/order" → /s/<slug>/order · path ของระบบ (api, _next, member, s ...) ไม่แปลง (คืน null)
 */
export function rewritePathForStoreDomain(pathname: string, slug: string): string | null {
  if (pathname === "/" || pathname === "") return `/s/${slug}`;
  if (pathname === "/order" || pathname.startsWith("/order/")) return `/s/${slug}${pathname}`;
  return null;
}
