import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import type { PlatformPromptPaySettings } from "./platform-settings";

export type SubscriptionQr =
  | { type: "payload"; payload: string; recipientName: string | null }
  | { type: "image"; imagePath: string; recipientName: string | null }
  | { type: "unconfigured" };

/**
 * Resolves how to present the PromptPay QR for a subscription payment:
 * - a dynamic EMVCo payload (amount-embedded) when a PromptPay id is configured;
 * - a static uploaded QR image for accounts without PromptPay;
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
      recipientName: settings.promptpayName,
    };
  }
  if (settings.promptpayQrImagePath) {
    return {
      type: "image",
      imagePath: settings.promptpayQrImagePath,
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
