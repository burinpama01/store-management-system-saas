import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeBeamSignature,
  isPlausibleBeamHmacKey,
  verifyBeamSignature,
} from "@/modules/payments/beam-signature";
import { parseBeamCharge, parseBeamQrChargeResponse } from "@/modules/payments/beam-client";
import {
  decodeBeamCredentials,
  decodeTrueMoneyOpenApiCredentials,
  encodeBeamCredentials,
  encodeTrueMoneyOpenApiCredentials,
} from "@/modules/payments/credentials";
import { getPaymentProviderAdapter } from "@/modules/payments/registry";
import { majorToSatang } from "@/modules/payments/money";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

// Test vector published in Beam's "Webhook Authentication" docs.
const DOC_KEY = "KOFELguf5L1ltuDlkDHGUkPPnQhrgYYijTR4Fqh7APc=";
const DOC_SIGNATURE = "1XzWtJHZ9Y1tmjkA/XZUIn1ZHrUQp1d0Ms0oDQfJBto=";
const DOC_BODY =
  '{"chargeId":"ch_30GtUweMWec7r2hHIsV5xxQeJKp","merchantId":"m_2sHxsByPwESKYM4nMwdEBdhubPS","referenceId":"order#10001","status":"SUCCEEDED","currency":"THB","amount":3000000,"source":"PAYMENT_LINK","sourceId":"57Iot6c11o","transactionTime":"2025-07-23T10:16:12Z","paymentMethod":{"paymentMethodType":"CARD","card":{"last4":"1111","brand":"VISA"},"cardInstallments":null,"cardNetworkToken":null,"qrPromptPay":null,"alipay":null,"weChatPay":null,"trueMoney":null,"linePay":null,"shopeePay":null,"bangkokBankApp":null,"kPlus":null,"scbEasy":null,"krungsriApp":null},"failureCode":"","customer":{"primaryPhone":{"countryCode":"+66","number":"0958051075"},"email":"","deliveryAddress":{"contactName":"","phone":{"countryCode":"","number":""},"address":{"streetAddress":"","city":"","country":"","postCode":""}}},"createdAt":"2025-07-23T10:15:56.102401Z","updatedAt":"2025-07-23T10:16:17.418991Z"}';

describe("Beam webhook signature", () => {
  it("matches the Beam documentation test vector", () => {
    expect(computeBeamSignature(DOC_BODY, DOC_KEY)).toBe(DOC_SIGNATURE);
    expect(verifyBeamSignature(DOC_BODY, DOC_SIGNATURE, DOC_KEY)).toBe(true);
  });

  it("rejects re-serialised JSON, a tampered body, a wrong key and a missing header", () => {
    const reserialised = JSON.stringify(JSON.parse(DOC_BODY), null, 2);
    expect(verifyBeamSignature(reserialised, DOC_SIGNATURE, DOC_KEY)).toBe(false);
    expect(verifyBeamSignature(DOC_BODY.replace("3000000", "3000001"), DOC_SIGNATURE, DOC_KEY)).toBe(false);
    expect(verifyBeamSignature(DOC_BODY, DOC_SIGNATURE, Buffer.alloc(32, 1).toString("base64"))).toBe(false);
    expect(verifyBeamSignature(DOC_BODY, null, DOC_KEY)).toBe(false);
    expect(verifyBeamSignature(DOC_BODY, DOC_SIGNATURE, "")).toBe(false);
  });

  it("validates the shape of a pasted HMAC key", () => {
    expect(isPlausibleBeamHmacKey(DOC_KEY)).toBe(true);
    expect(isPlausibleBeamHmacKey("not a key!")).toBe(false);
    expect(isPlausibleBeamHmacKey("c2hvcnQ=")).toBe(false);
  });
});

describe("Beam response parsing", () => {
  const EMV =
    "00020101021230830016A00000067701011201150107536000315080214KB0000019712340320KPS004KB000001971234531237645802TH5910EACH OTHER6007Bangkok62240520KB00000197123412345676304ABCD";

  it("uses rawData as the QR payload only when it is an EMV string", () => {
    const withEmv = parseBeamQrChargeResponse({
      chargeId: "ch_1",
      actionRequired: "ENCODED_IMAGE",
      encodedImage: { imageBase64Encoded: "iVBORw0K", rawData: EMV, expiry: "2026-09-18T10:00:00Z" },
    });
    expect(withEmv).toEqual({
      chargeId: "ch_1",
      qrPayload: EMV,
      qrImageBase64: "iVBORw0K",
      expiresAt: "2026-09-18T10:00:00Z",
    });

    const imageOnly = parseBeamQrChargeResponse({
      chargeId: "ch_2",
      encodedImage: { imageBase64Encoded: "iVBORw0K", rawData: "Sample QR Code for payment" },
    });
    expect(imageOnly?.qrPayload).toBeNull();
    expect(imageOnly?.qrImageBase64).toBe("iVBORw0K");
    expect(parseBeamQrChargeResponse({ encodedImage: {} })).toBeNull();
  });

  it("reads charge status and amount in satang", () => {
    expect(parseBeamCharge(JSON.parse(DOC_BODY))).toEqual({
      chargeId: "ch_30GtUweMWec7r2hHIsV5xxQeJKp",
      status: "SUCCEEDED",
      currency: "THB",
      amountSatang: 3000000,
      referenceId: "order#10001",
      failureCode: null,
    });
    expect(majorToSatang(30000)).toBe(3000000);
    expect(majorToSatang(89.9)).toBe(8990);
  });
});

describe("Beam credential codec", () => {
  const prev = process.env.PAYMENTS_CREDENTIALS_KEK;
  beforeEach(() => {
    process.env.PAYMENTS_CREDENTIALS_KEK = Buffer.alloc(32, 9).toString("base64");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.PAYMENTS_CREDENTIALS_KEK;
    else process.env.PAYMENTS_CREDENTIALS_KEK = prev;
  });

  it("encrypts merchant id, API key and HMAC key together (never plaintext)", () => {
    const encoded = encodeBeamCredentials({
      merchantId: "eachother-yvk0c7",
      apiKey: "sk_live_demo_123",
      webhookHmacKey: DOC_KEY,
    });
    expect(encoded.startsWith("v1:aesgcm:")).toBe(true);
    expect(encoded).not.toContain("sk_live_demo_123");
    expect(decodeBeamCredentials(encoded)).toEqual({
      merchantId: "eachother-yvk0c7",
      apiKey: "sk_live_demo_123",
      webhookHmacKey: DOC_KEY,
    });
  });

  it("keeps the TrueMoney Open API codec working after the shared refactor", () => {
    const encoded = encodeTrueMoneyOpenApiCredentials({ webhookSecret: "tmn-secret-0001", apiKey: null });
    expect(decodeTrueMoneyOpenApiCredentials(encoded)).toEqual({ webhookSecret: "tmn-secret-0001", apiKey: null });
    // A TrueMoney blob is not a valid Beam blob (no merchant id) and vice versa.
    expect(decodeBeamCredentials(encoded)).toBeNull();
  });
});

describe("Beam wiring", () => {
  it("registers a Beam adapter that creates, looks up and receives webhooks", () => {
    const adapter = getPaymentProviderAdapter("beam", "open_api");
    expect(adapter?.capabilities).toMatchObject({ createPayment: true, lookup: true, webhook: true, manualConfirm: false });
  });

  it("webhook route verifies the raw body, never re-serialised JSON", () => {
    const route = read("src/app/api/payments/webhooks/beam/route.ts");
    expect(route).toContain("await req.text()");
    expect(route).not.toContain("req.json()");
    expect(route).toContain('"x-beam-signature"');
  });

  it("webhook runs on the service client (no user session → RLS would drop writes)", () => {
    const webhook = read("src/modules/payments/webhook-beam.ts");
    expect(webhook).toContain("createSupabaseServiceClient");
    expect(webhook).not.toContain("createSupabaseServerClient");
    expect(webhook).toContain("verifyBeamSignature(");
    expect(webhook).toContain('provider_key: "beam"');
  });

  it("payment webhooks are reachable without a login", () => {
    const mw = read("src/server/integrations/supabase/middleware.ts");
    expect(mw).toContain('startsWith("/api/payments/webhooks/")');
  });

  it("POS closes a Beam bill only through a server-side claim of a PAID charge", () => {
    const actions = read("src/app/pos/actions.ts");
    expect(actions).toContain("claimBeamPaymentForOrder(");
    expect(actions).toContain("finalizeBeamPaymentForOrder(");
    // A failed close must free the payment for a retry.
    expect(actions.match(/if \(beamClaim && !beamClosed\) await releaseBeamPaymentClaim\(beamClaim\)/g)).toHaveLength(2);

    const service = read("src/modules/payments/beam-service.ts");
    expect(service).toMatch(/row\.status !== "PAID"/);
    expect(service).toContain('.is("pos_payment_id", null)');
  });
});
