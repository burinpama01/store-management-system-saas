import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encodeTrueMoneyOpenApiCredentials,
  decodeTrueMoneyOpenApiCredentials,
  maskSecret,
} from "@/modules/payments/credentials";
import {
  signTrueMoneyWebhookJwtHs256,
  verifyTrueMoneyWebhookJwtHs256,
  parseTrueMoneyWebhookClaims,
} from "@/modules/payments/truemoney-jwt";
import { canTransitionGatewayStatus } from "@/modules/payments/status";
import { getPaymentProviderAdapter } from "@/modules/payments/registry";
import { PaymentError } from "@/modules/payments/errors";

describe("TrueMoney Open API credential codec (AES-GCM v1)", () => {
  const prev = process.env.PAYMENTS_CREDENTIALS_KEK;
  beforeEach(() => {
    // 32 zero bytes base64
    process.env.PAYMENTS_CREDENTIALS_KEK = Buffer.alloc(32, 7).toString("base64");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PAYMENTS_CREDENTIALS_KEK;
    else process.env.PAYMENTS_CREDENTIALS_KEK = prev;
  });

  it("round-trips webhook secret and masks for UI", () => {
    const encoded = encodeTrueMoneyOpenApiCredentials({
      webhookSecret: "tmn-webhook-secret-demo-001",
      apiKey: null,
    });
    expect(encoded.startsWith("v1:aesgcm:")).toBe(true);
    const decoded = decodeTrueMoneyOpenApiCredentials(encoded);
    expect(decoded?.webhookSecret).toBe("tmn-webhook-secret-demo-001");
    const masked = maskSecret(decoded!.webhookSecret);
    expect(masked).toContain("•");
    expect(masked).not.toBe("tmn-webhook-secret-demo-001");
    expect(masked?.endsWith("-001")).toBe(true);
  });
});

describe("TrueMoney webhook JWT HS256 helper", () => {
  const secret = "test-webhook-secret-xyz";

  it("verifies a signed JWT and parses provisional claims", () => {
    const token = signTrueMoneyWebhookJwtHs256(
      {
        event_id: "evt_123",
        event_type: "P2P",
        amount_satang: 3500,
      },
      secret,
    );
    const claims = verifyTrueMoneyWebhookJwtHs256(token, secret);
    expect(claims.event_id).toBe("evt_123");
    const parsed = parseTrueMoneyWebhookClaims(claims);
    expect(parsed.eventId).toBe("evt_123");
    expect(parsed.eventType).toBe("P2P");
    expect(parsed.amountMajor).toBe(35);
  });

  it("rejects wrong secret", () => {
    const token = signTrueMoneyWebhookJwtHs256({ event_id: "x", amount_satang: 100 }, secret);
    expect(() => verifyTrueMoneyWebhookJwtHs256(token, "wrong")).toThrow();
  });
});

describe("Open API adapter + status paths", () => {
  it("registers open_api adapter with webhook capability and no live create", () => {
    const adapter = getPaymentProviderAdapter("truemoney", "open_api");
    expect(adapter).not.toBeNull();
    expect(adapter!.capabilities.webhook).toBe(true);
    expect(adapter!.capabilities.createPayment).toBe(false);
    expect(adapter!.capabilities.manualConfirm).toBe(false);
    expect(() =>
      adapter!.createDisplayPayment({ staticEmvPayload: "x", amountMajor: 10 }),
    ).toThrow(PaymentError);
  });

  it("allows PENDING→PAID and PAID→REFUND_SUCCEEDED; rejects labeling confusion path PAID→CANCELLED", () => {
    expect(canTransitionGatewayStatus("PENDING", "PAID")).toBe(true);
    expect(canTransitionGatewayStatus("PAID", "REFUND_SUCCEEDED")).toBe(true);
    expect(canTransitionGatewayStatus("PAID", "CANCELLED")).toBe(false);
  });
});
