import { describe, it, expect } from "vitest";
import { validateDonationSlip, matchSlipRecipient } from "@/modules/music-requests/donation-check";

const NOW = Date.parse("2026-06-29T12:00:00Z");
const CREATED = "2026-06-29T11:58:00Z";

function input(over: Partial<Parameters<typeof validateDonationSlip>[0]> = {}) {
  return {
    slipAmount: 100,
    slipTransRef: "REF123",
    slipTransDate: "2026-06-29T11:59:00Z",
    slipReceiverAccount: "xxx-xxx-5678",
    expectedAmount: 100,
    requestCreatedAt: CREATED,
    storePromptpayId: "0812345678",
    nowMs: NOW,
    ...over,
  };
}

describe("matchSlipRecipient", () => {
  it("matches on the last 4 digits (masked account)", () => {
    expect(matchSlipRecipient("0812345678", "xxx-xxx-5678")).toBe("match");
  });
  it("flags a clearly different account", () => {
    expect(matchSlipRecipient("0812345678", "xxx-xxx-9999")).toBe("mismatch");
  });
  it("is unknown when data is insufficient", () => {
    expect(matchSlipRecipient("0812345678", null)).toBe("unknown");
    expect(matchSlipRecipient(null, "xxx-xxx-5678")).toBe("unknown");
  });
});

describe("validateDonationSlip", () => {
  it("accepts a fresh, exact, correctly-addressed slip", () => {
    expect(validateDonationSlip(input())).toEqual({ ok: true });
  });

  it("rejects a missing reference", () => {
    expect(validateDonationSlip(input({ slipTransRef: null }))).toMatchObject({ error: "no_ref" });
  });

  it("rejects an amount that does not match exactly", () => {
    expect(validateDonationSlip(input({ slipAmount: 50 }))).toMatchObject({ error: "amount_mismatch" });
    expect(validateDonationSlip(input({ slipAmount: 120 }))).toMatchObject({ error: "amount_mismatch" });
    expect(validateDonationSlip(input({ slipAmount: null }))).toMatchObject({ error: "amount_mismatch" });
  });

  it("rejects a slip paid to a different account", () => {
    expect(validateDonationSlip(input({ slipReceiverAccount: "xxx-xxx-9999" }))).toMatchObject({
      error: "wrong_recipient",
    });
  });

  it("rejects an old slip", () => {
    expect(
      validateDonationSlip(input({ slipTransDate: "2026-06-29T10:00:00Z" })),
    ).toMatchObject({ error: "too_old" });
  });

  it("rejects a slip paid before the donation was started", () => {
    expect(
      validateDonationSlip(
        input({ slipTransDate: "2026-06-29T11:50:00Z", requestCreatedAt: "2026-06-29T11:58:00Z" }),
      ),
    ).toMatchObject({ error: "before_request" });
  });

  it("allows when slip2go provides no parseable date (real slip already verified)", () => {
    expect(validateDonationSlip(input({ slipTransDate: null }))).toEqual({ ok: true });
    expect(validateDonationSlip(input({ slipTransDate: "not-a-date" }))).toEqual({ ok: true });
  });

  it("allows when the recipient cannot be determined (no over-block)", () => {
    expect(validateDonationSlip(input({ slipReceiverAccount: null }))).toEqual({ ok: true });
  });
});
