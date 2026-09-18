import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Beam webhook authentication:
 *   X-Beam-Signature = base64( HMAC-SHA256( key = base64decode(HMAC key), raw request body ) )
 *
 * The body MUST be the exact bytes received — re-serialising parsed JSON changes
 * whitespace/key order and breaks the signature.
 */
export function computeBeamSignature(rawBody: string, hmacKeyBase64: string): string {
  const key = Buffer.from(hmacKeyBase64.trim(), "base64");
  return createHmac("sha256", key).update(Buffer.from(rawBody, "utf8")).digest("base64");
}

export function verifyBeamSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  hmacKeyBase64: string,
): boolean {
  const provided = signatureHeader?.trim();
  if (!provided || !hmacKeyBase64.trim()) return false;
  const expected = Buffer.from(computeBeamSignature(rawBody, hmacKeyBase64), "utf8");
  const actual = Buffer.from(provided, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** An HMAC key from Lighthouse is base64 of at least 16 bytes. */
export function isPlausibleBeamHmacKey(value: string): boolean {
  const v = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  return Buffer.from(v, "base64").length >= 16;
}
