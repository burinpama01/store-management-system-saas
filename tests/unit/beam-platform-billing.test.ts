import { describe, expect, it } from "vitest";
import { evaluateBeamBillingCharge, evaluateBillingSlip } from "@/modules/billing/beam-billing-policy";

describe("platform Beam evidence", () => {
  const order = { id: "order-1", charge_id: "ch_1", amount: 690, created_at: "2026-09-21T00:00:00Z", expires_at: "2026-09-21T00:15:00Z", receiver_account: "1234567890" };
  const charge = { chargeId: "ch_1", referenceId: "order-1", status: "SUCCEEDED", currency: "THB", amountSatang: 69000, failureCode: null };
  it("accepts only an exact successful charge", () => {
    expect(evaluateBeamBillingCharge(order, charge)).toBe(true);
    for (const change of [{ amountSatang: 690 }, { referenceId: "other" }, { chargeId: "other" }, { status: "PENDING" }, { amountSatang: null }, { currency: "USD" }, { currency: null }]) {
      expect(evaluateBeamBillingCharge(order, { ...charge, ...change })).toBe(false);
    }
  });
  const slip = { ok: true, amount: 690, transRef: "bank-ref", receiverAccount: "1234567890", receiverName: null, transDate: "2026-09-21T00:05:00Z", raw: null, error: null };
  it("requires amount, receiver and transaction time rather than trusting an upload", () => {
    expect(evaluateBillingSlip(order, slip)).toBeNull();
    for (const change of [{ amount: 689 }, { amount: 700 }, { receiverAccount: null }, { receiverAccount: "9999997890" }, { transDate: null }, { transDate: "2026-09-20T00:00:00Z" }, { transDate: "2026-09-22T00:00:00Z" }, { transRef: "" }, { ok: false }]) {
      expect(evaluateBillingSlip(order, { ...slip, ...change, transDate: change.transDate === null ? undefined : (change.transDate ?? slip.transDate) })).not.toBeNull();
    }
  });
});
