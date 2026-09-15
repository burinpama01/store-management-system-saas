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
  /** Masked EMV payload for settings UI. */
  staticEmvPayloadMasked: string | null;
  hasStaticEmvPayload: boolean;
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
  createdAt: string;
  updatedAt: string;
}

export interface TrueMoneyManualCredentials {
  staticEmvPayload: string;
}
