export interface DonationSlipCheckInput {
  slipAmount: number | null;
  slipTransRef: string | null;
  slipTransDate: string | null;
  slipReceiverAccount: string | null;
  expectedAmount: number;
  /** When the donation request was created (ISO). */
  requestCreatedAt: string;
  /** Store PromptPay id (phone or national id) the donation should be paid to. */
  storePromptpayId: string | null;
  nowMs: number;
  /** Max age of the slip in minutes (default 60). */
  maxAgeMinutes?: number;
}

export type DonationSlipError =
  | "no_ref"
  | "amount_mismatch"
  | "too_old"
  | "before_request"
  | "wrong_recipient";

export const DONATION_SLIP_ERROR_MESSAGE: Record<DonationSlipError, string> = {
  no_ref: "สลิปไม่มีเลขอ้างอิง",
  amount_mismatch: "ยอดในสลิปไม่ตรงกับยอดโดเนท",
  too_old: "สลิปนี้เก่าเกินไป กรุณาโอนใหม่",
  before_request: "สลิปนี้เกิดก่อนการขอโดเนท",
  wrong_recipient: "สลิปไม่ได้โอนเข้าบัญชีของร้าน",
};

/** Digits only. */
function digits(s: string): string {
  return (s ?? "").replace(/\D/g, "");
}

/**
 * Best-effort recipient match: confirms the slip was paid to the store's
 * PromptPay. slip2go often masks the account, so we compare the last 4 digits.
 * Returns "unknown" when there isn't enough data to decide (don't block then).
 */
export function matchSlipRecipient(
  storePromptpayId: string | null,
  slipReceiverAccount: string | null,
): "match" | "mismatch" | "unknown" {
  const store = digits(storePromptpayId ?? "");
  const recv = digits(slipReceiverAccount ?? "");
  if (store.length < 4 || recv.length < 4) return "unknown";
  const last4 = store.slice(-4);
  return recv.includes(last4) ? "match" : "mismatch";
}

/**
 * Server-side slip validation beyond slip2go's own read: exact amount, recipient
 * match, and (when the slip carries a timestamp) a fresh date paid after the
 * donation started. Rejects reused / old / wrong-amount / wrong-account slips
 * that slip2go alone would accept.
 */
export function validateDonationSlip(
  input: DonationSlipCheckInput,
): { ok: true } | { ok: false; error: DonationSlipError } {
  if (!input.slipTransRef) return { ok: false, error: "no_ref" };

  if (input.slipAmount == null || Math.abs(input.slipAmount - input.expectedAmount) > 0.01) {
    return { ok: false, error: "amount_mismatch" };
  }

  // Recipient: reject only when we can confidently tell it's a different account.
  if (matchSlipRecipient(input.storePromptpayId, input.slipReceiverAccount) === "mismatch") {
    return { ok: false, error: "wrong_recipient" };
  }

  // Freshness only when the slip provides a parseable timestamp.
  if (input.slipTransDate) {
    const slipMs = Date.parse(input.slipTransDate);
    if (!Number.isNaN(slipMs)) {
      const maxAgeMs = (input.maxAgeMinutes ?? 60) * 60_000;
      if (input.nowMs - slipMs > maxAgeMs) return { ok: false, error: "too_old" };
      const createdMs = Date.parse(input.requestCreatedAt);
      if (!Number.isNaN(createdMs) && slipMs < createdMs - 5 * 60_000) {
        return { ok: false, error: "before_request" };
      }
    }
  }

  return { ok: true };
}
