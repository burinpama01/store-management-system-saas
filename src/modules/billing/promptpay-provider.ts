import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import type { PlatformPromptPaySettings } from "./platform-settings";

export type SubscriptionQr =
  | { type: "payload"; payload: string; amountEmbedded: boolean; recipientName: string | null }
  | { type: "unconfigured" };

function crc16(data: string): string {
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

interface Tlv {
  tag: string;
  value: string;
}

function parseTlv(s: string): Tlv[] | null {
  const out: Tlv[] = [];
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

function buildTlv(items: Tlv[]): string {
  return items
    .map((t) => t.tag + t.value.length.toString().padStart(2, "0") + t.value)
    .join("");
}

/**
 * Converts a static PromptPay EMVCo payload into a dynamic one with an embedded
 * amount: sets POI (tag 01) to "12" (dynamic), inserts/replaces the transaction
 * amount (tag 54), and recomputes the CRC (tag 63). Returns null if the payload
 * cannot be parsed (caller should fall back to the static payload).
 */
export function injectAmountIntoStaticPayload(payload: string, amount: number): string | null {
  if (!(amount > 0)) return null;
  const items = parseTlv(payload.trim());
  if (!items) return null;

  const next = items.filter((t) => t.tag !== "63" && t.tag !== "54");

  const poi = next.find((t) => t.tag === "01");
  if (poi) poi.value = "12";
  else next.splice(1, 0, { tag: "01", value: "12" });

  const amt: Tlv = { tag: "54", value: amount.toFixed(2) };
  const i53 = next.findIndex((t) => t.tag === "53");
  if (i53 >= 0) {
    next.splice(i53 + 1, 0, amt);
  } else {
    const i58 = next.findIndex((t) => t.tag === "58");
    if (i58 >= 0) next.splice(i58, 0, amt);
    else next.push(amt);
  }

  const body = buildTlv(next) + "6304";
  return body + crc16(body);
}

/** Heuristic check that a decoded string is an EMVCo / PromptPay payload. */
export function looksLikePromptPayPayload(payload: string): boolean {
  const s = payload.trim();
  if (s.length < 20) return false;
  // EMVCo payloads start with the payload-format-indicator TLV "0002" + version.
  if (!s.startsWith("0002")) return false;
  // PromptPay application id or a Thai-domestic QR (currency 764 / country TH).
  return s.includes("A000000677010111") || s.includes("5303764") || s.includes("5802TH");
}

/**
 * Resolves how to present the PromptPay QR for a subscription payment:
 * - a dynamic EMVCo payload (amount-embedded) when a PromptPay id is configured;
 * - the EMVCo payload decoded from the super admin's uploaded QR image
 *   (static, customer enters the amount) when only that is configured;
 * - unconfigured when the super admin has set neither.
 */
export function resolveSubscriptionQr(
  settings: PlatformPromptPaySettings,
  amount: number,
): SubscriptionQr {
  if (settings.promptpayId) {
    return {
      type: "payload",
      payload: buildPromptPayPayload({ recipientId: settings.promptpayId, amount }),
      amountEmbedded: true,
      recipientName: settings.promptpayName,
    };
  }
  if (settings.promptpayStaticPayload) {
    // Embed the package amount into the uploaded static QR so the customer does
    // not have to type it; fall back to the raw static payload if injection fails.
    const withAmount = injectAmountIntoStaticPayload(settings.promptpayStaticPayload, amount);
    return {
      type: "payload",
      payload: withAmount ?? settings.promptpayStaticPayload,
      amountEmbedded: withAmount != null,
      recipientName: settings.promptpayName,
    };
  }
  return { type: "unconfigured" };
}

/** Last 4 significant digits of a PromptPay id / account, for soft receiver matching. */
export function last4Digits(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Soft receiver verification: if a PromptPay id is configured and the slip
 * exposes a receiver account, require the last 4 digits to match. When the
 * slip's receiver cannot be determined, do not block (return true) — amount and
 * ref dedupe remain the hard guards.
 */
export function receiverMatches(
  promptpayId: string | null,
  receiverAccount: string | null,
): boolean {
  const want = last4Digits(promptpayId);
  const got = last4Digits(receiverAccount);
  if (!want || !got) return true;
  return want === got;
}
