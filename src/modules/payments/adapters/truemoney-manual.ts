import { injectAmountIntoStaticPayload, looksLikeEmvPayload } from "../emv-qr";
import { PaymentError, PaymentErrorCodes } from "../errors";
import type { PaymentProviderAdapter } from "../provider-contract";

export const trueMoneyManualAdapter: PaymentProviderAdapter = {
  key: "truemoney",
  mode: "manual",
  capabilities: {
    createPayment: true,
    webhook: false,
    lookup: false,
    refund: false,
    manualConfirm: true,
  },
  createDisplayPayment({ staticEmvPayload, amountMajor }) {
    if (!looksLikeEmvPayload(staticEmvPayload)) {
      throw new PaymentError(PaymentErrorCodes.INVALID_PAYLOAD, "TrueMoney Shop QR ไม่ถูกต้อง");
    }
    const injected = injectAmountIntoStaticPayload(staticEmvPayload, amountMajor);
    if (!injected) {
      throw new PaymentError(
        PaymentErrorCodes.INJECT_FAILED,
        "ไม่สามารถล็อกยอดลง TrueMoney QR ได้",
      );
    }
    return {
      status: "PENDING",
      display: { kind: "emv_qr", payload: injected, amountEmbedded: true },
      providerPaymentId: null,
      metadata: { verificationSource: "MANUAL_STAFF" },
    };
  },
};
