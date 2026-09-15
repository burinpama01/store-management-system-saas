import { describe, it, expect } from "vitest";
import {
  injectAmountIntoStaticPayload,
  looksLikeEmvPayload,
  maskEmvPayload,
  crc16Ccitt,
} from "@/modules/payments/emv-qr";
import { trueMoneyManualAdapter } from "@/modules/payments/adapters/truemoney-manual";
import { canTransitionGatewayStatus, isTerminalGatewayStatus } from "@/modules/payments/status";
import {
  encodeTrueMoneyManualCredentials,
  decodeTrueMoneyManualCredentials,
} from "@/modules/payments/credentials";
import { canUseFeature, getPlanFeatures, type BillingState } from "@/modules/billing/types";
import { injectAmountIntoStaticPayload as billingInject } from "@/modules/billing/promptpay-provider";

/** User shop static QR (decoded) — validated live for 35 & 265 THB. */
const SHOP_STATIC =
  "00020101021129390016A00000067701011103151400009568790455802TH53037646304543D";

const LIVE_35 =
  "00020101021229390016A00000067701011103151400009568790455802TH5303764540535.006304FACE";
const LIVE_265 =
  "00020101021229390016A00000067701011103151400009568790455802TH53037645406265.006304C6C5";

function assertValidCrc(payload: string) {
  expect(payload.slice(-4)).toBe(crc16Ccitt(payload.slice(0, -4)));
}

describe("TrueMoney amount-locked EMV inject", () => {
  it("matches live-validated 35.00 and 265.00 payloads", () => {
    expect(looksLikeEmvPayload(SHOP_STATIC)).toBe(true);
    const out35 = injectAmountIntoStaticPayload(SHOP_STATIC, 35);
    const out265 = injectAmountIntoStaticPayload(SHOP_STATIC, 265);
    expect(out35).toBe(LIVE_35);
    expect(out265).toBe(LIVE_265);
    assertValidCrc(out35!);
    assertValidCrc(out265!);
  });

  it("never returns the raw static shop QR for positive amounts", () => {
    const out = injectAmountIntoStaticPayload(SHOP_STATIC, 99.5);
    expect(out).not.toBeNull();
    expect(out).not.toBe(SHOP_STATIC);
    expect(out).toContain("010212");
    expect(out).toContain("540599.50");
  });

  it("billing and payments share the same inject implementation", () => {
    expect(billingInject(SHOP_STATIC, 35)).toBe(injectAmountIntoStaticPayload(SHOP_STATIC, 35));
  });

  it("adapter rejects bad payload and builds amount-locked QR", () => {
    expect(() =>
      trueMoneyManualAdapter.createDisplayPayment({
        staticEmvPayload: "not-emv",
        amountMajor: 10,
      }),
    ).toThrow();
    const created = trueMoneyManualAdapter.createDisplayPayment({
      staticEmvPayload: SHOP_STATIC,
      amountMajor: 35,
    });
    expect(created.status).toBe("PENDING");
    expect(created.display?.payload).toBe(LIVE_35);
    expect(created.display?.amountEmbedded).toBe(true);
  });

  it("masks payloads for settings UI", () => {
    const masked = maskEmvPayload(SHOP_STATIC);
    expect(masked).not.toBe(SHOP_STATIC);
    expect(masked.startsWith("0002010102")).toBe(true);
    expect(masked.includes("…")).toBe(true);
  });
});

describe("gateway confirm idempotency (status machine)", () => {
  it("allows PENDING → PAID once; PAID is terminal for re-pay", () => {
    expect(canTransitionGatewayStatus("PENDING", "PAID")).toBe(true);
    expect(canTransitionGatewayStatus("PAID", "PAID")).toBe(true); // no-op
    expect(canTransitionGatewayStatus("PAID", "PENDING")).toBe(false);
    expect(isTerminalGatewayStatus("PAID")).toBe(true);
    expect(canTransitionGatewayStatus("FAILED", "PAID")).toBe(false);
  });
});

describe("credential codec v0", () => {
  it("round-trips static EMV payload", () => {
    const encoded = encodeTrueMoneyManualCredentials({ staticEmvPayload: SHOP_STATIC });
    expect(encoded.startsWith("v0:")).toBe(true);
    expect(decodeTrueMoneyManualCredentials(encoded)?.staticEmvPayload).toBe(SHOP_STATIC);
  });
});

describe("byoPaymentGateway feature gate", () => {
  function state(plan: BillingState["plan"]): BillingState {
    return {
      plan,
      status: "active",
      currentPeriodEnd: "2030-01-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      trialEnd: null,
    };
  }

  it("is off on free/starter/standard and on for premium+/enterprise", () => {
    expect(canUseFeature(state("free"), "byoPaymentGateway")).toBe(false);
    expect(canUseFeature(state("starter"), "byoPaymentGateway")).toBe(false);
    expect(canUseFeature(state("standard"), "byoPaymentGateway")).toBe(false);
    expect(canUseFeature(state("premium"), "byoPaymentGateway")).toBe(true);
    expect(canUseFeature(state("enterprise"), "byoPaymentGateway")).toBe(true);
  });

  it("business plan only unlocks when feature selected", () => {
    const without: BillingState = {
      ...state("business"),
      business: { seats: 2, stores: 1, features: ["groceryPos"] },
    };
    const withFeat: BillingState = {
      ...state("business"),
      business: { seats: 2, stores: 1, features: ["byoPaymentGateway"] },
    };
    expect(getPlanFeatures(without).byoPaymentGateway).toBe(false);
    expect(getPlanFeatures(withFeat).byoPaymentGateway).toBe(true);
  });
});
