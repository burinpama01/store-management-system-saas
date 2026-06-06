import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import type { PlatformPromptPaySettings } from "./platform-settings";

export type SubscriptionQr =
  | { type: "payload"; payload: string; amountEmbedded: boolean; recipientName: string | null }
  | { type: "unconfigured" };

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
    return {
      type: "payload",
      payload: settings.promptpayStaticPayload,
      amountEmbedded: false,
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
