import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * สิทธิ์ของลูกค้า (ไม่มี session) ในการถามสถานะ/ยกเลิกการจ่ายค่าขอเพลงผ่าน Beam
 * - UUID ของคำขอไม่ใช่สิทธิ์ — ต้องถือ token ที่ server เซ็นให้ตอนสร้าง QR เท่านั้น
 * - ผูก storeId + requestId + gatewayPaymentId + purpose + วันหมดอายุ แก้ค่าใดค่าหนึ่ง = ลายเซ็นไม่ตรง
 * - เซ็นเพื่อกันแก้ ไม่ได้เข้ารหัส (ค่าข้างในเป็นสิ่งที่ลูกค้ารู้อยู่แล้ว)
 */
export const MUSIC_PAYMENT_TOKEN_PURPOSE = "music_payment_check";
/** QR Beam อายุ 10 นาที + เผื่อ webhook/lookup มาช้า */
export const MUSIC_PAYMENT_TOKEN_TTL_MS = 30 * 60 * 1000;

export interface MusicPaymentClaims {
  storeId: string;
  requestId: string;
  gatewayPaymentId: string;
  purpose: typeof MUSIC_PAYMENT_TOKEN_PURPOSE;
  /** epoch ms */
  exp: number;
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(`${MUSIC_PAYMENT_TOKEN_PURPOSE}:${payloadB64}`).digest("base64url");
}

export function createMusicPaymentToken(
  claims: Omit<MusicPaymentClaims, "purpose" | "exp">,
  secret: string,
  nowMs: number = Date.now(),
): string {
  if (!secret) throw new Error("Invalid music payment token secret");
  const full: MusicPaymentClaims = { ...claims, purpose: MUSIC_PAYMENT_TOKEN_PURPOSE, exp: nowMs + MUSIC_PAYMENT_TOKEN_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export function verifyMusicPaymentToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): MusicPaymentClaims | null {
  if (!secret || typeof token !== "string" || token.length > 2048) return null;
  const [payloadB64, signature, extra] = token.split(".");
  if (!payloadB64 || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payloadB64, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: MusicPaymentClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as MusicPaymentClaims;
  } catch {
    return null;
  }
  if (claims.purpose !== MUSIC_PAYMENT_TOKEN_PURPOSE) return null;
  if (typeof claims.exp !== "number" || claims.exp < nowMs) return null;
  if (!claims.storeId || !claims.requestId || !claims.gatewayPaymentId) return null;
  return claims;
}

/**
 * secret: MUSIC_PAYMENT_TOKEN_SECRET (แนะนำ) หรือ derive จาก service role key (มีเสมอฝั่ง server)
 * โดยไม่ใช้ key ตรง ๆ · ไม่มีทั้งคู่ = null (action ตอบ error แบบ fail closed)
 */
export function resolveMusicPaymentTokenSecret(env: Readonly<Record<string, string | undefined>>): string | null {
  const explicit = env.MUSIC_PAYMENT_TOKEN_SECRET;
  if (typeof explicit === "string" && explicit.length >= 16) return explicit;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof serviceKey === "string" && serviceKey.length >= 16) {
    return createHmac("sha256", serviceKey).update("storeos:music-payment-token:v1").digest("hex");
  }
  return null;
}

/**
 * กันถามถี่เกินต่อคำขอ (best-effort ต่อ instance) — ด่านหลักคือ throttle การถาม Beam ฝั่ง server
 */
const lastPollAt = new Map<string, number>();
export function allowMusicPaymentPoll(requestId: string, nowMs: number = Date.now(), minIntervalMs = 2000): boolean {
  const last = lastPollAt.get(requestId);
  if (last !== undefined && nowMs - last < minIntervalMs) return false;
  if (lastPollAt.size > 5000) lastPollAt.clear();
  lastPollAt.set(requestId, nowMs);
  return true;
}
