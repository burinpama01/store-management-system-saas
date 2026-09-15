import { trueMoneyManualAdapter } from "./adapters/truemoney-manual";
import { trueMoneyOpenApiAdapter } from "./adapters/truemoney-openapi";
import type { PaymentProviderAdapter } from "./provider-contract";
import type { PaymentProviderKey, PaymentProviderMode } from "./types";

const adapters: PaymentProviderAdapter[] = [trueMoneyManualAdapter, trueMoneyOpenApiAdapter];

export function getPaymentProviderAdapter(
  key: PaymentProviderKey,
  mode: PaymentProviderMode,
): PaymentProviderAdapter | null {
  return adapters.find((a) => a.key === key && a.mode === mode) ?? null;
}
