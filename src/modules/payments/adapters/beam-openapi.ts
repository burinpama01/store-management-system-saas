import { PaymentError, PaymentErrorCodes } from "../errors";
import type { PaymentProviderAdapter } from "../provider-contract";

/**
 * Beam (BYO merchant account) — charges are created over HTTP in beam-service.ts
 * (QR PromptPay via POST /api/v1/charges), not by injecting a static EMV payload,
 * so the synchronous display hook is intentionally unsupported.
 */
export const beamOpenApiAdapter: PaymentProviderAdapter = {
  key: "beam",
  mode: "open_api",
  capabilities: {
    createPayment: true,
    webhook: true,
    lookup: true,
    refund: false,
    manualConfirm: false,
  },
  createDisplayPayment() {
    throw new PaymentError(
      PaymentErrorCodes.CONFIG_DISABLED,
      "Beam สร้าง QR ผ่าน API (createBeamQrPayment) ไม่ใช่ static EMV",
    );
  },
};
