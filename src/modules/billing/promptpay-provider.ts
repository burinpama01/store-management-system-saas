import { buildPromptPayPayload } from "@/modules/printing/promptpay-qr";
import {
  injectAmountIntoStaticPayload,
  looksLikePromptPayPayload,
} from "@/modules/payments/emv-qr";
import type { PlatformPromptPaySettings } from "./platform-settings";

export type SubscriptionQr =
  | { type: "payload"; payload: string; amountEmbedded: boolean; recipientName: string | null }
  | { type: "unconfigured" };

export {
  injectAmountIntoStaticPayload,
  looksLikePromptPayPayload,
} from "@/modules/payments/emv-qr";

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
