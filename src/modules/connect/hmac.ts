// HMAC สำหรับ webhook สองทางของ StoreOS Connect (เซ็น/ตรวจ + กัน replay ด้วย timestamp)
import { createHmac, timingSafeEqual } from "node:crypto";

const SIG_PREFIX = "sha256=";
/** หน้าต่างเวลาที่ยอมรับ (วินาที) กัน replay */
export const CONNECT_TS_SKEW_SEC = 300;

/** เซ็น raw body → "sha256=<hex>" */
export function signConnectPayload(rawBody: string, secret: string): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `${SIG_PREFIX}${hex}`;
}

/** เทียบ signature แบบ timing-safe (รับได้ทั้งมี/ไม่มี prefix "sha256=") */
export function verifyConnectSignature(
  rawBody: string,
  secret: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = signConnectPayload(rawBody, secret);
  const got = signatureHeader.startsWith(SIG_PREFIX)
    ? signatureHeader
    : `${SIG_PREFIX}${signatureHeader}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** ตรวจว่า timestamp (epoch วินาที) อยู่ในหน้าต่างที่ยอมรับ; ถ้าไม่ส่ง ts มาให้ผ่าน (optional) */
export function isFreshTimestamp(
  ts: number | undefined | null,
  nowSec: number = Math.floor(Date.now() / 1000),
  skewSec: number = CONNECT_TS_SKEW_SEC,
): boolean {
  if (ts == null) return true;
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowSec - ts) <= skewSec;
}
