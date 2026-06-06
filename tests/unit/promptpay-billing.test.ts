import { describe, it, expect } from "vitest";
import {
  getSubscriptionPrice,
  computeNewExpiry,
  isSubscriptionCurrent,
  isPaidTier,
} from "@/modules/billing/pricing";
import { parseSlip2goResponse } from "@/modules/billing/slip2go";
import { evaluatePaymentVerification } from "@/modules/billing/subscription-service";
import { receiverMatches, last4Digits, resolveSubscriptionQr } from "@/modules/billing/promptpay-provider";
import type { Slip2goVerification } from "@/modules/billing/slip2go";
import type { PlatformPromptPaySettings } from "@/modules/billing/platform-settings";

describe("pricing", () => {
  it("returns prices for paid tiers and null otherwise", () => {
    expect(getSubscriptionPrice("starter", "30d")).toBe(690);
    expect(getSubscriptionPrice("premium", "1y")).toBe(22900);
    expect(getSubscriptionPrice("free", "30d")).toBeNull();
    expect(getSubscriptionPrice("enterprise", "1y")).toBeNull();
  });

  it("isPaidTier discriminates", () => {
    expect(isPaidTier("standard")).toBe(true);
    expect(isPaidTier("free")).toBe(false);
    expect(isPaidTier("enterprise")).toBe(false);
  });

  it("computeNewExpiry extends from now when not currently active", () => {
    const now = new Date("2026-06-06T00:00:00Z");
    expect(computeNewExpiry(null, "30d", now)).toBe("2026-07-06T00:00:00.000Z");
    expect(computeNewExpiry("2026-01-01T00:00:00Z", "30d", now)).toBe("2026-07-06T00:00:00.000Z");
  });

  it("computeNewExpiry stacks remaining time when still active", () => {
    const now = new Date("2026-06-06T00:00:00Z");
    // current expiry in the future -> extend from it
    expect(computeNewExpiry("2026-06-20T00:00:00Z", "30d", now)).toBe("2026-07-20T00:00:00.000Z");
    expect(computeNewExpiry("2026-06-20T00:00:00Z", "1y", now)).toBe("2027-06-20T00:00:00.000Z");
  });

  it("isSubscriptionCurrent checks the window", () => {
    const now = new Date("2026-06-06T00:00:00Z");
    expect(isSubscriptionCurrent("2026-07-01T00:00:00Z", now)).toBe(true);
    expect(isSubscriptionCurrent("2026-01-01T00:00:00Z", now)).toBe(false);
    expect(isSubscriptionCurrent(null, now)).toBe(false);
  });
});

describe("parseSlip2goResponse", () => {
  it("parses a data-enveloped response with nested amount/receiver", () => {
    const r = parseSlip2goResponse({
      success: true,
      data: {
        amount: { amount: 690 },
        receiver: { displayName: "STORE OS", account: { value: "xxx-x-x1234-x" } },
        transRef: "ABC123",
      },
    });
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(690);
    expect(r.receiverName).toBe("STORE OS");
    expect(r.receiverAccount).toBe("xxx-x-x1234-x");
    expect(r.transRef).toBe("ABC123");
  });

  it("parses a flat response and infers ok from ref+amount", () => {
    const r = parseSlip2goResponse({ amountValue: "1290", referenceNo: "REF9" });
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(1290);
    expect(r.transRef).toBe("REF9");
  });

  it("returns not-ok with message on failure", () => {
    const r = parseSlip2goResponse({ success: false, message: "invalid slip" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid slip");
  });
});

function verification(over: Partial<Slip2goVerification>): Slip2goVerification {
  return { ok: true, amount: 690, receiverName: "X", receiverAccount: "1234", transRef: "R1", raw: null, error: null, ...over };
}

describe("evaluatePaymentVerification", () => {
  it("accepts a valid slip with sufficient amount", () => {
    expect(evaluatePaymentVerification(verification({}), 690, null)).toEqual({ ok: true, reason: null });
  });

  it("rejects when slip2go failed", () => {
    const r = evaluatePaymentVerification(verification({ ok: false, error: "bad" }), 690, null);
    expect(r.ok).toBe(false);
  });

  it("rejects underpayment", () => {
    const r = evaluatePaymentVerification(verification({ amount: 500 }), 690, null);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("ยอดโอน");
  });

  it("rejects missing transaction ref", () => {
    const r = evaluatePaymentVerification(verification({ transRef: null }), 690, null);
    expect(r.ok).toBe(false);
  });

  it("rejects receiver mismatch when promptpay id configured", () => {
    const r = evaluatePaymentVerification(verification({ receiverAccount: "9999" }), 690, "0812341234");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("บัญชีผู้รับ");
  });

  it("accepts when receiver last-4 matches", () => {
    const r = evaluatePaymentVerification(verification({ receiverAccount: "xxx1234" }), 690, "0899991234");
    expect(r.ok).toBe(true);
  });
});

describe("promptpay-provider", () => {
  it("last4Digits extracts trailing digits", () => {
    expect(last4Digits("xxx-x-x1234-x")).toBe("1234");
    expect(last4Digits("12")).toBeNull();
    expect(last4Digits(null)).toBeNull();
  });

  it("receiverMatches is lenient when data missing, strict when both present", () => {
    expect(receiverMatches(null, "1234")).toBe(true);
    expect(receiverMatches("0812341234", null)).toBe(true);
    expect(receiverMatches("0812341234", "xxx1234")).toBe(true);
    expect(receiverMatches("0812341234", "xxx9999")).toBe(false);
  });

  it("resolveSubscriptionQr prefers payload, then image, then unconfigured", () => {
    const base: PlatformPromptPaySettings = {
      billingProvider: "promptpay",
      promptpayId: null,
      promptpayName: "X",
      promptpayQrImagePath: null,
    };
    expect(resolveSubscriptionQr({ ...base, promptpayId: "0812345678" }, 690).type).toBe("payload");
    expect(resolveSubscriptionQr({ ...base, promptpayQrImagePath: "https://x/q.png" }, 690).type).toBe("image");
    expect(resolveSubscriptionQr(base, 690).type).toBe("unconfigured");
  });
});
