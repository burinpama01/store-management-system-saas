import type { GatewayPaymentStatus, PaymentProviderKey, PaymentProviderMode } from "./types";

export interface ProviderCapabilities {
  createPayment: boolean;
  webhook: boolean;
  lookup: boolean;
  refund: boolean;
  manualConfirm: boolean;
}

export interface CreatePaymentDisplay {
  kind: "emv_qr";
  payload: string;
  amountEmbedded: boolean;
}

export interface CreatePaymentResult {
  status: GatewayPaymentStatus;
  display: CreatePaymentDisplay | null;
  providerPaymentId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PaymentProviderAdapter {
  readonly key: PaymentProviderKey;
  readonly mode: PaymentProviderMode;
  readonly capabilities: ProviderCapabilities;
  createDisplayPayment(input: {
    staticEmvPayload: string;
    amountMajor: number;
  }): CreatePaymentResult;
}
