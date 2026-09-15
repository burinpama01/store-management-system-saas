import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Provisional TrueMoney Wallet Open API incoming-payment webhook JWT helper.
 * Community-documented shape: POST { "message": "<JWT>" } signed HS256 with merchant webhook secret.
 * TODO: verify header/claim names against official in-app TrueMoney docs when merchant is eligible.
 */

function base64UrlToBuffer(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function bufferToBase64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function signTrueMoneyWebhookJwtHs256(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const h = bufferToBase64Url(Buffer.from(JSON.stringify(header), "utf8"));
  const p = bufferToBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${bufferToBase64Url(sig)}`;
}

export function verifyTrueMoneyWebhookJwtHs256(
  token: string,
  secret: string,
): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("รูปแบบ JWT ไม่ถูกต้อง");
  }
  const [h, p, s] = parts;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlToBuffer(h).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("อ่าน JWT header ไม่ได้");
  }
  if (header.alg && header.alg !== "HS256") {
    throw new Error(`อัลกอริทึม JWT ไม่รองรับ: ${String(header.alg)}`);
  }
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const actual = base64UrlToBuffer(s);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("ลายเซ็น JWT ไม่ถูกต้อง");
  }
  try {
    return JSON.parse(base64UrlToBuffer(p).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("อ่าน JWT payload ไม่ได้");
  }
}

/** Extract provisional event fields from decoded JWT claims (community shape — verify officially). */
export function parseTrueMoneyWebhookClaims(claims: Record<string, unknown>): {
  eventId: string;
  eventType: string | null;
  amountMajor: number | null;
  amountSatang: number | null;
} {
  const eventIdRaw =
    claims.event_id ??
    claims.eventId ??
    claims.transaction_id ??
    claims.transactionId ??
    claims.jti ??
    claims.id;
  const eventId = eventIdRaw != null ? String(eventIdRaw) : "";
  if (!eventId) {
    throw new Error("JWT ไม่มีรหัสเหตุการณ์ (event/transaction id)");
  }

  const eventTypeRaw = claims.event_type ?? claims.eventType ?? claims.type ?? null;
  const eventType = eventTypeRaw != null ? String(eventTypeRaw) : null;

  // Amount often in satang (1/100 THB) in community samples.
  let amountSatang: number | null = null;
  let amountMajor: number | null = null;
  const satangRaw = claims.amount_satang ?? claims.amountSatang ?? claims.amount;
  if (typeof satangRaw === "number" && Number.isFinite(satangRaw)) {
    // Heuristic: integers >= 100 without decimal likely satang; explicit amount_satang always satang.
    if (claims.amount_satang != null || claims.amountSatang != null || Number.isInteger(satangRaw)) {
      amountSatang = Math.round(satangRaw);
      amountMajor = amountSatang / 100;
    } else {
      amountMajor = satangRaw;
      amountSatang = Math.round(satangRaw * 100);
    }
  } else if (typeof satangRaw === "string" && satangRaw.trim()) {
    const n = Number(satangRaw);
    if (Number.isFinite(n)) {
      amountSatang = Math.round(n);
      amountMajor = amountSatang / 100;
    }
  }
  const majorRaw = claims.amount_major ?? claims.amountMajor ?? claims.amount_thb;
  if (typeof majorRaw === "number" && Number.isFinite(majorRaw)) {
    amountMajor = majorRaw;
    amountSatang = Math.round(majorRaw * 100);
  }

  return { eventId, eventType, amountMajor, amountSatang };
}
