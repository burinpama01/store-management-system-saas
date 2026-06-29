import { describe, it, expect } from "vitest";
import {
  getSubscriptionPrice,
  computeNewExpiry,
  isSubscriptionCurrent,
  isPaidTier,
  hasBillingAccess,
} from "@/modules/billing/pricing";
import { parseSlip2goResponse } from "@/modules/billing/slip2go";
import { evaluatePaymentVerification } from "@/modules/billing/subscription-service";
import { receiverMatches, last4Digits, resolveSubscriptionQr, looksLikePromptPayPayload, injectAmountIntoStaticPayload } from "@/modules/billing/promptpay-provider";
import { applyPromotion, pickActivePromotion, computeUpgradeCredit, type Promotion } from "@/modules/billing/pricing-repository";
import type { Slip2goVerification } from "@/modules/billing/slip2go";
import type { PlatformPromptPaySettings } from "@/modules/billing/platform-settings";
import type { BillingState } from "@/modules/billing/types";

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

  it("hasBillingAccess lets active Enterprise tenants use the app without a paid-tier expiry", () => {
    const now = new Date("2026-06-06T00:00:00Z");
    const enterprise: BillingState = {
      plan: "enterprise",
      status: "active",
      currentPeriodEnd: "2026-01-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    };

    expect(hasBillingAccess(enterprise, now)).toBe(true);
    expect(hasBillingAccess({ ...enterprise, currentPeriodEnd: "" }, now)).toBe(true);
  });

  it("hasBillingAccess still blocks inactive Enterprise and expired paid plans", () => {
    const now = new Date("2026-06-06T00:00:00Z");
    const enterprise: BillingState = {
      plan: "enterprise",
      status: "canceled",
      currentPeriodEnd: "2099-12-31T23:59:59Z",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    };
    const premium: BillingState = {
      plan: "premium",
      status: "active",
      currentPeriodEnd: "2026-01-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    };

    expect(hasBillingAccess(enterprise, now)).toBe(false);
    expect(hasBillingAccess(premium, now)).toBe(false);
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

  it("treats slip2go fraud envelope (code 200500) as not-ok", () => {
    const r = parseSlip2goResponse({
      code: "200500",
      message: "Slip is fraud.",
      data: { referenceId: "abc-123" },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Slip is fraud.");
  });

  it("accepts slip2go success envelope (code 200000)", () => {
    const r = parseSlip2goResponse({
      code: "200000",
      message: "success",
      data: {
        amount: { amount: 690 },
        receiver: { account: { value: "x1234" } },
        transRef: "TX1",
      },
    });
    expect(r.ok).toBe(true);
    expect(r.amount).toBe(690);
    expect(r.transRef).toBe("TX1");
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

describe("pricing promotions", () => {
  function promo(over: Partial<Promotion>): Promotion {
    return { id: "p", description: "d", percentOff: 10, active: true, plan: null, startsAt: null, endsAt: null, ...over };
  }

  it("applyPromotion discounts and rounds to baht", () => {
    expect(applyPromotion(690, 0)).toBe(690);
    expect(applyPromotion(690, 20)).toBe(552);
    expect(applyPromotion(1290, 15)).toBe(1097); // 1096.5 -> 1097
  });

  it("computeUpgradeCredit prorates actual paid amount by remaining days", () => {
    const start = "2026-06-01T00:00:00Z";
    const end = "2026-07-01T00:00:00Z"; // 30-day window
    // halfway through: ~15 days remaining of 30 -> ~half the paid amount
    const mid = new Date("2026-06-16T00:00:00Z");
    expect(computeUpgradeCredit({ periodStart: start, periodEnd: end, lastPaidAmount: 690, now: mid })).toBe(345);
    // promo price credit: paid 552 (20% off), halfway -> 276
    expect(computeUpgradeCredit({ periodStart: start, periodEnd: end, lastPaidAmount: 552, now: mid })).toBe(276);
  });

  it("computeUpgradeCredit is zero when expired, unpaid, or no window", () => {
    const start = "2026-06-01T00:00:00Z";
    const end = "2026-07-01T00:00:00Z";
    expect(computeUpgradeCredit({ periodStart: start, periodEnd: end, lastPaidAmount: 690, now: new Date("2026-08-01T00:00:00Z") })).toBe(0);
    expect(computeUpgradeCredit({ periodStart: start, periodEnd: end, lastPaidAmount: 0, now: new Date("2026-06-16T00:00:00Z") })).toBe(0);
    expect(computeUpgradeCredit({ periodStart: null, periodEnd: null, lastPaidAmount: 690 })).toBe(0);
  });

  it("pickActivePromotion picks strongest valid promo within window", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const rows = [
      promo({ id: "a", percentOff: 10 }),
      promo({ id: "b", percentOff: 25 }),
      promo({ id: "c", percentOff: 50, active: false }), // inactive
      promo({ id: "d", percentOff: 40, endsAt: "2026-06-01T00:00:00Z" }), // expired
      promo({ id: "e", percentOff: 30, startsAt: "2026-07-01T00:00:00Z" }), // not started
    ];
    expect(pickActivePromotion(rows, now)?.id).toBe("b");
    expect(pickActivePromotion([], now)).toBeNull();
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

  it("resolveSubscriptionQr prefers dynamic id, then static payload, then unconfigured", () => {
    const base: PlatformPromptPaySettings = {
      billingProvider: "promptpay",
      promptpayId: null,
      promptpayName: "X",
      promptpayStaticPayload: null,
      enterpriseFromEmail: null,
      logoUrl: null,
    };
    const dynamic = resolveSubscriptionQr({ ...base, promptpayId: "0812345678" }, 690);
    expect(dynamic.type).toBe("payload");
    expect(dynamic.type === "payload" && dynamic.amountEmbedded).toBe(true);

    const staticPayload = "00020101021129390016A000000677010111031500499907032586453037645802TH6304D564";
    const staticQr = resolveSubscriptionQr({ ...base, promptpayStaticPayload: staticPayload }, 690);
    expect(staticQr.type).toBe("payload");
    // A valid static payload gets the amount injected -> amountEmbedded true.
    expect(staticQr.type === "payload" && staticQr.amountEmbedded).toBe(true);

    expect(resolveSubscriptionQr(base, 690).type).toBe("unconfigured");
  });

  it("injectAmountIntoStaticPayload embeds amount + valid CRC, leaves unparseable as null", () => {
    const staticPayload = "00020101021129390016A000000677010111031500499907032586453037645802TH6304D564";
    const out = injectAmountIntoStaticPayload(staticPayload, 690);
    expect(out).not.toBeNull();
    const payload = out as string;
    // POI switched to dynamic (010212) and amount tag 54 present (690.00).
    expect(payload).toContain("010212");
    expect(payload).toContain("5406690.00");
    expect(looksLikePromptPayPayload(payload)).toBe(true);
    // CRC (last 4) must match recomputed checksum over body incl. "6304".
    const crc16 = (data: string) => {
      let c = 0xffff;
      for (let i = 0; i < data.length; i++) {
        c ^= data.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) { c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1; c &= 0xffff; }
      }
      return c.toString(16).toUpperCase().padStart(4, "0");
    };
    expect(payload.slice(-4)).toBe(crc16(payload.slice(0, -4)));
    expect(injectAmountIntoStaticPayload("not a payload", 690)).toBeNull();
  });

  it("looksLikePromptPayPayload validates EMVCo PromptPay strings", () => {
    // A real PromptPay payload contains the app id and TH/THB markers.
    const good = "00020101021129370016A00000067701011101130066812345678530376463041234";
    expect(looksLikePromptPayPayload(good)).toBe(true);
    expect(looksLikePromptPayPayload("hello world")).toBe(false);
    expect(looksLikePromptPayPayload("0002")).toBe(false);
  });
});
