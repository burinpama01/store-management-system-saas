/**
 * Shared EMVCo QR helpers for PromptPay (billing) and TrueMoney Shop QR (BYO).
 * Amount injection must stay identical across both — validated live on TrueMoney.
 */

export interface EmvTlv {
  tag: string;
  value: string;
}

export function crc16Ccitt(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function parseEmvTlv(s: string): EmvTlv[] | null {
  const out: EmvTlv[] = [];
  let i = 0;
  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    const len = parseInt(s.slice(i + 2, i + 4), 10);
    if (Number.isNaN(len)) return null;
    const value = s.slice(i + 4, i + 4 + len);
    if (value.length < len) return null;
    out.push({ tag, value });
    i += 4 + len;
  }
  return i === s.length ? out : null;
}

export function buildEmvTlv(items: EmvTlv[]): string {
  return items
    .map((t) => t.tag + t.value.length.toString().padStart(2, "0") + t.value)
    .join("");
}

/**
 * Converts a static EMVCo payload into a dynamic one with an embedded amount:
 * sets POI (tag 01) to "12" (dynamic), inserts/replaces transaction amount (tag 54),
 * and recomputes CRC (tag 63). Returns null if the payload cannot be parsed.
 */
export function injectAmountIntoStaticPayload(payload: string, amount: number): string | null {
  if (!(amount > 0)) return null;
  const items = parseEmvTlv(payload.trim());
  if (!items) return null;

  const next = items.filter((t) => t.tag !== "63" && t.tag !== "54");

  const poi = next.find((t) => t.tag === "01");
  if (poi) poi.value = "12";
  else next.splice(1, 0, { tag: "01", value: "12" });

  const amt: EmvTlv = { tag: "54", value: amount.toFixed(2) };
  const i53 = next.findIndex((t) => t.tag === "53");
  if (i53 >= 0) {
    next.splice(i53 + 1, 0, amt);
  } else {
    const i58 = next.findIndex((t) => t.tag === "58");
    if (i58 >= 0) next.splice(i58, 0, amt);
    else next.push(amt);
  }

  const body = buildEmvTlv(next) + "6304";
  return body + crc16Ccitt(body);
}

/** Heuristic check that a decoded string is an EMVCo / PromptPay / Thai QR payload. */
export function looksLikeEmvPayload(payload: string): boolean {
  const s = payload.trim();
  if (s.length < 20) return false;
  if (!s.startsWith("0002")) return false;
  return s.includes("A000000677010111") || s.includes("5303764") || s.includes("5802TH");
}

/** @deprecated Prefer looksLikeEmvPayload — kept as alias for billing callers. */
export const looksLikePromptPayPayload = looksLikeEmvPayload;

/** Mask an EMV payload for UI (show prefix + suffix only). */
export function maskEmvPayload(payload: string): string {
  const s = payload.trim();
  if (s.length <= 16) return "••••";
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}
