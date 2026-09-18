export type PaymentProviderKey = "truemoney" | "beam" | "omise";
export type PaymentProviderMode = "manual" | "open_api";
export type PaymentEnvironment = "test" | "live";

export type GatewayPaymentStatus =
  | "CREATED"
  | "PENDING"
  | "REQUIRES_ACTION"
  | "PROCESSING"
  | "PAID"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "REFUND_PENDING"
  | "REFUND_SUCCEEDED"
  | "REFUND_FAILED"
  | "LATE_PAID"
  | "REVIEW_REQUIRED";

export type VerificationSource = "MANUAL_STAFF" | "PROVIDER_WEBHOOK" | "PROVIDER_API";

export interface PaymentProviderConfig {
  id: string;
  organizationId: string;
  storeId: string;
  providerKey: PaymentProviderKey;
  mode: PaymentProviderMode;
  environment: PaymentEnvironment;
  displayName: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  disabledAt: string | null;
  /** Server-only; never send full payload to the browser. */
  staticEmvPayload: string | null;
  publicConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentProviderConfigPublic {
  id: string;
  providerKey: PaymentProviderKey;
  mode: PaymentProviderMode;
  environment: PaymentEnvironment;
  displayName: string | null;
  isEnabled: boolean;
  isDefault: boolean;
  disabledAt: string | null;
  /** Masked EMV payload for settings UI (manual mode). */
  staticEmvPayloadMasked: string | null;
  hasStaticEmvPayload: boolean;
  /** Open API: masked webhook secret only — never full secret. */
  webhookSecretMasked: string | null;
  hasWebhookSecret: boolean;
  /** Beam: masked merchant id + whether an API key is stored (never the key itself). */
  merchantIdMasked?: string | null;
  hasApiKey?: boolean;
  updatedAt: string;
}

export interface GatewayPayment {
  id: string;
  organizationId: string;
  storeId: string;
  orderId: string | null;
  providerConfigId: string;
  providerKey: PaymentProviderKey;
  mode: PaymentProviderMode;
  amount: number;
  currency: string;
  status: GatewayPaymentStatus;
  storeosReference: string;
  injectedEmvPayload: string | null;
  verificationSource: VerificationSource | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  confirmReason: string | null;
  posPaymentId: string | null;
  paidAt: string | null;
  failureMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TrueMoneyManualCredentials {
  staticEmvPayload: string;
}

export type TrueMoneyManualTestResult =
  | {
      ok: true;
      mode: "manual";
      providerKey: "truemoney";
      eWalletIdMasked: string | null;
      sampleInjectedCrcOk: true;
      capabilities: {
        createPayment: true;
        webhook: false;
        lookup: false;
        refund: false;
        manualConfirm: true;
      };
      message: string;
      summary?: {
        hasAid: boolean;
        country: string | null;
        currency: string | null;
      };
    }
  | { ok: false; error: string };

export interface TrueMoneyOpenApiCredentials {
  webhookSecret: string;
  apiKey?: string | null;
}

export type TrueMoneyOpenApiTestResult =
  | {
      ok: true;
      mode: "open_api";
      providerKey: "truemoney";
      webhookSecretMasked: string;
      webhookUrl: string;
      capabilities: {
        createPayment: false;
        webhook: true;
        lookup: false;
        refund: false;
        manualConfirm: false;
      };
      message: string;
    }
  | { ok: false; error: string };


export interface BeamCredentials {
  merchantId: string;
  apiKey: string;
  /** Base64 HMAC key from Lighthouse → Developers → Webhooks. */
  webhookHmacKey: string | null;
}

export type BeamTestResult =
  | {
      ok: true;
      providerKey: "beam";
      environment: PaymentEnvironment;
      merchantIdMasked: string | null;
      hasWebhookKey: boolean;
      webhookUrl: string;
      message: string;
    }
  | { ok: false; error: string };

/** What the POS needs to render a Beam QR and poll it. */
export interface BeamQrForPos {
  gatewayPaymentId: string;
  amount: number;
  status: GatewayPaymentStatus;
  qrPayload: string | null;
  qrImageBase64: string | null;
  expiresAt: string | null;
}
